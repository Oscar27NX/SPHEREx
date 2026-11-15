import argparse
import base64
import gzip
import hashlib
import json
import math
import os
import re
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
from astropy.time import Time

from archive import Archive, CACHE_VERSION, DiskCache, empty_sky, encoded

BASE_DIR = Path(__file__).resolve().parent


def load_config():
    return json.loads((BASE_DIR / "releases.json").read_text(encoding="utf-8"))


def normalize_query(ra, dec, fov=300, window=10, release="auto"):
    values = [float(v) for v in (ra, dec, fov, window)]
    if not all(math.isfinite(v) for v in values):
        raise ValueError("Coordinates, FOV and window must be finite numbers")
    ra, dec, fov, window = values
    if not -90 <= dec <= 90:
        raise ValueError("Declination must be between -90 and 90 degrees")
    if not 60 <= fov <= 1800:
        raise ValueError("FOV must be between 60 and 1800 arcseconds")
    if not 0.5 <= window <= 15:
        raise ValueError("Time window must be between 0.5 and 15 years")
    if release != "auto" and not re.fullmatch(r"spherex_(?:dr|qr)\d+", release):
        raise ValueError("Unknown release; use auto or an advertised SIA collection")
    return round(ra % 360, 6), round(dec, 6), round(fov, 3), round(window, 3), release


def cached_preview(candidates, config, query):
    ra, dec, fov, window, release = query
    compatible = [item for item in candidates if item and item[1].get("epochs")
                  and all(field in item[1] for field in ("frames_b64", "flags_b64", "wavelength_maps_b64", "bandwidth_maps_b64"))
                  and abs(item[1]["ra"] - ra) < 1e-6 and abs(item[1]["dec"] - dec) < 1e-6
                  and item[1]["window"] >= window]
    compatible.sort(key=lambda item: (item[1]["fov"] < fov, abs(item[1]["fov"] - fov), -item[0]))
    cutoff = Time.now().mjd - window * 365.25
    for _, source in compatible:
        indices = [i for i, ep in enumerate(source["epochs"]) if
                   (release == "auto" or ep["source"] in (release, release + "_deep"))
                   and ep["mjd"] >= cutoff]
        if not indices:
            continue
        result = dict(source, fov=fov, window=window, release={"id": release}, preview=True,
                      pixel_scale_arcsec=fov / source["grid_size"], measurements=[], message="Cached preview; refining requested field. Uncovered pixels are blank.")
        grid = source["grid_size"]
        positions = np.floor((np.arange(grid) + .5 - grid / 2) * fov / source["fov"] + grid / 2).astype(int)
        valid = (positions >= 0) & (positions < grid)
        clipped = np.clip(positions, 0, grid - 1)
        mask = valid[:, None] & valid[None, :]
        for field, dtype, extra in [("frames_b64", "<f4", (6,)), ("flags_b64", "<u4", ()),
                                     ("wavelength_maps_b64", "<f4", ()), ("bandwidth_maps_b64", "<f4", ())]:
            data = np.frombuffer(base64.b64decode(source[field]), dtype=dtype).reshape((len(source["epochs"]), *extra, grid, grid))[indices]
            data = data[..., clipped[:, None], clipped[None, :]].copy()
            data[..., ~mask] = (1 << 9) if dtype == "<u4" else np.nan
            result[field] = encoded(data, dtype)
        result["epochs"] = [dict(source["epochs"][i], index=j) for j, i in enumerate(indices)]
        included = {(ep["mjd"], d - 1) for ep in result["epochs"] for d in ep["detectors"]}
        result["measurements"] = [m for m in source.get("measurements", []) if (m["mjd"], m["detector"]) in included]
        result["sources"] = [dict(s, px=(s["px"]-grid/2)*source["fov"]/fov+grid/2,
                                   py=(s["py"]-grid/2)*source["fov"]/fov+grid/2) for s in source["sources"]]
        result["sources"] = [s for s in result["sources"] if 0 <= s["px"] < grid and 0 <= s["py"] < grid]
        return result
    return None


class SkyEngine:
    def __init__(self, directory=None, archive=None):
        self.config = load_config()
        self.cache = DiskCache(directory or os.environ.get("SPHEREX_CACHE_DIR", BASE_DIR / ".cache"))
        self.archive = archive or Archive(self.cache)
        self.pool = ThreadPoolExecutor(max_workers=2)
        self.lock = threading.Lock()
        self.memory = OrderedDict()
        with self.cache.connect() as db:
            keys = [r[0] for r in db.execute("SELECT key FROM cache WHERE key LIKE 'sky:%' ORDER BY created DESC LIMIT 24")]
        for key in reversed(keys):
            self.memory[key] = self.cache.get(key)
        self.pending = {}
        self.errors = {}
        self.progress = {}
        self.ttl = float(os.environ.get("SPHEREX_CACHE_TTL", "3600"))

    def configuration(self):
        config = dict(self.config)
        cached = self.cache.get("collections")
        collections = cached[1] if cached else []
        config["releases"] = [{"id": "auto", "label": "All current releases"}] + [
            {"id": name, "label": name.replace("spherex_", "SPHEREx ").upper()}
            for name in collections if not name.endswith("_deep")]
        return config

    def _refresh(self, key, query):
        def progress(**values):
            with self.lock:
                self.progress[key].update(values)
        try:
            payload = self.archive.build_sky(self.config, *query, progress=progress)
            self.cache.put(key, payload)
            with self.lock:
                self.errors.pop(key, None)
                self.memory[key] = (time.time(), payload)
                self.memory.move_to_end(key)
                while len(self.memory) > 24:
                    self.memory.popitem(last=False)
            return payload
        except Exception as exc:
            with self.lock:
                self.errors[key] = (time.time(), str(exc))
            raise
        finally:
            with self.lock:
                self.progress.pop(key, None)

    def get_sky_cube(self, ra, dec, fov_arcsec=300, window_years=10, release_id="auto", wait=False, force=False):
        started = time.perf_counter()
        query = normalize_query(ra, dec, fov_arcsec, window_years, release_id or "auto")
        key = "sky:" + hashlib.sha256(json.dumps([CACHE_VERSION, *query]).encode()).hexdigest()
        with self.lock:
            cached = self.memory.get(key)
            if cached:
                self.memory.move_to_end(key)
        if cached is None:
            cached = self.cache.get(key)
            if cached:
                with self.lock:
                    self.memory[key] = cached
                    while len(self.memory) > 24:
                        self.memory.popitem(last=False)
        stale = cached is None or time.time() - cached[0] >= self.ttl or force
        with self.lock:
            future = self.pending.get(key)
            if future and future.done():
                self.pending.pop(key, None)
                future = None
            error = self.errors.get(key)
            if stale and future is None and (force or error is None or time.time() - error[0] >= 60):
                self.progress[key] = {"phase": "queued", "completed": 0, "total": 0, "started_at": time.time()}
                future = self.pool.submit(self._refresh, key, query)
                self.pending[key] = future
        if wait and future:
            result = dict(future.result())
            result["cache"] = "REFRESH"
        elif cached:
            result = dict(cached[1])
            result["cache"] = "STALE" if stale else "HIT"
        else:
            with self.lock:
                candidates = list(self.memory.values())
            result = cached_preview(candidates, self.config, query) or empty_sky(self.config, *query)
            result["cache"] = "MISS"
            if error:
                if result["data_status"] != "ready":
                    result.update(data_status="error", message="The archive is temporarily unavailable. Retrying shortly; try another target or release.")
        result["refreshing"] = bool(future and not future.done())
        with self.lock:
            progress = self.progress.get(key)
            if progress:
                result["progress"] = {k: v for k, v in progress.items() if k != "started_at"}
                result["progress"]["elapsed_seconds"] = round(time.time() - progress["started_at"])
        if error:
            result["refresh_error"] = "Archive update delayed. Cached observations remain available."
        result["server_ms"] = round((time.perf_counter() - started) * 1000, 3)
        return result

    def prewarm(self, wait=False):
        results = []
        for target in self.config["preset_targets"]:
            try:
                sky = self.get_sky_cube(target["ra"], target["dec"], target["fov"], wait=wait)
                results.append({"target": target["name"], "status": sky["data_status"], "cache": sky["cache"],
                                "epochs": len(sky["epochs"]), "message": sky["message"],
                                "catalog_errors": sky.get("provenance", {}).get("catalog_errors", {}),
                                "cutout_errors": sky.get("provenance", {}).get("cutout_errors", [])})
            except Exception as exc:
                results.append({"target": target["name"], "status": "error", "message": str(exc)})
        return results


class SpherexHandler(SimpleHTTPRequestHandler):
    engine = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def log_message(self, format, *args):
        pass

    def _send_json(self, obj, status=HTTPStatus.OK):
        raw = json.dumps(obj, allow_nan=False, separators=(",", ":")).encode("utf-8")
        encodings = self.headers.get("Accept-Encoding", "").lower().replace(" ", "").split(",")
        compressed = len(raw) > 2048 and any(value == "gzip" or value.startswith("gzip;q=1") for value in encodings)
        if compressed:
            raw = gzip.compress(raw, compresslevel=1)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if compressed:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_GET(self):
        try:
            self._get()
        except (ValueError, TypeError) as exc:
            self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            self._send_json({"error": "The archive is temporarily unavailable. Please retry shortly."}, HTTPStatus.BAD_GATEWAY)

    def _get(self):
        parsed = urlparse(self.path)
        qs = {key: values[0] for key, values in parse_qs(parsed.query).items()}
        if parsed.path == "/api/state":
            target = self.engine.config["preset_targets"][0]
            sky = self.engine.get_sky_cube(target["ra"], target["dec"], target["fov"])
            self._send_json({"config": self.engine.configuration(), "initial_sky": sky})
            return
        if parsed.path in ("/api/sky", "/api/catalogs"):
            target = self.engine.config["preset_targets"][0]
            sky = self.engine.get_sky_cube(qs.get("ra", target["ra"]), qs.get("dec", target["dec"]),
                                           qs.get("fov", 300), qs.get("window", 10), qs.get("release", "auto"))
            if parsed.path == "/api/catalogs":
                self._send_json({"sources": sky["sources"], "status": sky["data_status"]})
            else:
                self._send_json(sky)
            return
        if parsed.path in ("/", "/index.html", "/app.js", "/style.css", "/vendor/d3.v7.min.js", "/vendor/aladin-3.8.2.js"):
            self.path = "/index.html" if parsed.path == "/" else parsed.path
            super().do_GET()
            return
        self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self):
        try:
            path = urlparse(self.path).path
            if path == "/api/releases/reload":
                self.engine.archive.collections(force=True)
                self._send_json({"releases": self.engine.configuration()["releases"]})
                return
            if path == "/api/batch":
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 65536:
                    raise ValueError("Batch body must be between 1 and 65536 bytes")
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError("Batch body must be an object")
                queries = body.get("queries", [])
                if not isinstance(queries, list) or len(queries) > 24:
                    raise ValueError("Batch must contain at most 24 queries")
                if any(not isinstance(query, dict) for query in queries):
                    raise ValueError("Each batch query must be an object")
                results = [self.engine.get_sky_cube(q["ra"], q["dec"], q.get("fov", 300),
                           q.get("window", 10), q.get("release", "auto")) for q in queries]
                self._send_json({"results": results, "count": len(results)})
                return
            self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except (ValueError, TypeError, KeyError) as exc:
            self._send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            self._send_json({"error": "The archive is temporarily unavailable. Please retry shortly."}, HTTPStatus.BAD_GATEWAY)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--precache", action="store_true", help="Download and verify all five target previews, then exit")
    args = parser.parse_args()
    engine = SkyEngine()
    if args.precache:
        engine.prewarm()
        report = engine.prewarm(wait=True)
        (engine.cache.directory / "precache-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2))
        engine.pool.shutdown()
        raise SystemExit(0 if all(r["status"] == "ready" for r in report) else 1)
    SpherexHandler.engine = engine
    port = int(os.environ.get("SPHEREX_PORT", "8080"))
    server = ThreadingHTTPServer(("127.0.0.1", port), SpherexHandler)
    if os.environ.get("SPHEREX_PREWARM", "1") != "0":
        engine.prewarm()
    print(f"SPHEREx server listening on http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        engine.pool.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
