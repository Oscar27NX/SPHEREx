import base64
import hashlib
import io
import json
import math
import re
import sqlite3
import threading
import time
import xml.etree.ElementTree as ET
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import requests
from astropy.io import fits
from astropy.io.votable import parse_single_table
from astropy.time import Time
from astropy.wcs import WCS
from scipy import fft
from scipy.ndimage import map_coordinates
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
GRID_SIZE = 64
CACHE_VERSION = 3


class ArchiveError(RuntimeError):
    pass


def get_remote(url, params=None):
    retries = Retry(total=2, read=0, backoff_factor=0.5, status_forcelist=(429, 502, 503, 504))
    with requests.Session() as session:
        session.mount("https://", HTTPAdapter(max_retries=retries))
        response = session.get(url, params=params, timeout=(10, 60))
        response.raise_for_status()
        return response.content


def read_votable(raw):
    root = ET.fromstring(raw)
    for info in root.iter():
        if info.tag.endswith("INFO") and info.get("name") == "QUERY_STATUS":
            if info.get("value", "").upper() == "ERROR":
                raise ArchiveError(info.text or "Archive query failed")
    table = parse_single_table(io.BytesIO(raw)).to_table(use_names_over_ids=True)
    rows = []
    for row in table:
        item = {}
        for name in table.colnames:
            value = row[name]
            if np.ma.is_masked(value):
                value = None
            elif isinstance(value, np.generic):
                value = value.item()
            if isinstance(value, bytes):
                value = value.decode("utf-8")
            if isinstance(value, float) and not math.isfinite(value):
                value = None
            item[name] = value
        rows.append(item)
    overflow = any(i.get("value") == "OVERFLOW" for i in root.iter() if i.tag.endswith("INFO"))
    return rows, overflow


class DiskCache:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "archive.sqlite3"
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, created REAL, body BLOB)")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self, key):
        with self.connect() as db:
            row = db.execute("SELECT created, body FROM cache WHERE key=?", (key,)).fetchone()
        if row is None:
            return None
        return row[0], json.loads(zlib.decompress(row[1]))

    def put(self, key, value):
        body = zlib.compress(json.dumps(value, allow_nan=False, separators=(",", ":")).encode())
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO cache VALUES (?, ?, ?)", (key, time.time(), body))


def display_wcs(ra, dec, fov):
    wcs = WCS(naxis=2)
    wcs.wcs.crpix = [(GRID_SIZE + 1) / 2] * 2
    wcs.wcs.crval = [ra, dec]
    wcs.wcs.cdelt = [-fov / 3600 / GRID_SIZE, -fov / 3600 / GRID_SIZE]
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    return wcs


def compute_spectral_fft(spectrum, wavelengths_um):
    values = np.asarray(spectrum, dtype=float)
    wavelengths = np.asarray(wavelengths_um, dtype=float)
    if values.ndim != 1 or values.size < 4 or values.shape != wavelengths.shape:
        raise ValueError("FFT requires matching one-dimensional samples and wavelengths")
    spacing = np.diff(wavelengths)
    if not np.all(np.isfinite(values)) or not np.all(np.isfinite(wavelengths)):
        raise ValueError("FFT requires finite samples; missing bands must not be fabricated")
    if np.any(spacing <= 0) or not np.allclose(spacing, spacing[0], rtol=1e-5, atol=1e-10):
        raise ValueError("FFT requires uniform wavelength spacing; irregular observations are not FFT bins")
    coefficients = fft.rfft(values)
    frequency = fft.rfftfreq(values.size, d=spacing[0])
    k = np.arange(coefficients.size)
    fraction = k / max(1, values.size // 2)
    masks = {"low": fraction <= 1/3, "mid": (fraction > 1/3) & (fraction <= 2/3), "high": fraction > 2/3}
    return {
        "fft_amplitude": np.abs(coefficients).tolist(),
        "fft_frequency_per_um": frequency.tolist(),
        "fft_period_um": [None if f == 0 else float(1 / f) for f in frequency],
        "fft_bands": {name: fft.irfft(coefficients * mask, n=values.size).tolist() for name, mask in masks.items()},
    }


def resample_spectral_grid(measurements, grid_size=32):
    valid = sorted(
        (float(m["wavelength_um"]), float(m["brightness"]))
        for m in (measurements or [])
        if m.get("wavelength_um") is not None and m.get("brightness") is not None
        and math.isfinite(m["wavelength_um"]) and math.isfinite(m["brightness"]) and m["wavelength_um"] > 0
    )
    if len(valid) < 2:
        return None
    merged_w, merged_b = [], []
    for w, b in valid:
        if merged_w and abs(w - merged_w[-1]) < 1e-4:
            merged_w[-1] = 0.5 * (merged_w[-1] + w)
            merged_b[-1] = 0.5 * (merged_b[-1] + b)
        else:
            merged_w.append(w)
            merged_b.append(b)
    if len(merged_w) < 2 or merged_w[-1] <= merged_w[0]:
        return None
    grid_w = np.linspace(merged_w[0], merged_w[-1], max(4, int(grid_size)), dtype=float)
    grid_b = np.interp(grid_w, np.asarray(merged_w, dtype=float), np.asarray(merged_b, dtype=float))
    result = compute_spectral_fft(grid_b, grid_w)
    result["grid_wavelength_um"] = grid_w.tolist()
    result["grid_brightness"] = grid_b.tolist()
    return result


def aperture_sample(plane, wave_plane, band_plane):
    center = (GRID_SIZE - 1) / 2.0
    yy, xx = np.mgrid[:GRID_SIZE, :GRID_SIZE]
    dist = np.hypot(xx - center, yy - center)
    valid = np.isfinite(plane) & np.isfinite(wave_plane) & (wave_plane > 0)
    for radius in (0.75, 1.5, 3.0, 5.0, 8.0, 12.0, 64.0):
        mask = valid & (dist <= radius)
        if np.any(mask):
            b_vals = band_plane[mask]
            band_finite = b_vals[np.isfinite(b_vals) & (b_vals > 0)]
            return (
                float(np.median(wave_plane[mask])),
                float(np.median(band_finite)) if band_finite.size else 0.02,
                float(np.median(plane[mask])),
                float(radius),
            )
    return None, None, None, None


def propagate_gaia_radec(ra_deg, dec_deg, pmra_mas_yr, pmdec_mas_yr, ref_epoch, target_epoch=2026.5):
    if any(v is None or not math.isfinite(v) for v in (ra_deg, dec_deg, pmra_mas_yr, pmdec_mas_yr, ref_epoch)):
        return ra_deg, dec_deg
    rad = math.pi / 180.0
    ra, dec = ra_deg * rad, dec_deg * rad
    scale = (target_epoch - ref_epoch) * rad / 3600000.0
    east, north = pmra_mas_yr * scale, pmdec_mas_yr * scale
    x = math.cos(dec) * math.cos(ra) - east * math.sin(ra) - north * math.sin(dec) * math.cos(ra)
    y = math.cos(dec) * math.sin(ra) + east * math.cos(ra) - north * math.sin(dec) * math.sin(ra)
    z = math.sin(dec) + north * math.cos(dec)
    return (math.atan2(y, x) / rad) % 360.0, math.atan2(z, math.hypot(x, y)) / rad


def encoded(array, dtype="<f4"):
    return base64.b64encode(np.ascontiguousarray(array, dtype=dtype).tobytes()).decode("ascii")


def detector_number(row):
    match = re.search(r"D([1-6])_", row.get("access_url", ""))
    return int(match[1]) if match else None


def covers_center(row, ra, dec):
    region = row.get("s_region", "")
    if not region.upper().startswith("POLYGON"):
        return False
    numbers = re.findall(r"[-+]?\d+(?:\.\d*)?(?:[Ee][-+]?\d+)?", region)
    if len(numbers) < 6 or len(numbers) % 2:
        return False
    points = np.radians(np.array(numbers, dtype=float).reshape(-1, 2))
    vertices = np.column_stack((np.cos(points[:, 1]) * np.cos(points[:, 0]),
                                np.cos(points[:, 1]) * np.sin(points[:, 0]), np.sin(points[:, 1])))
    lon, lat = math.radians(ra), math.radians(dec)
    point = [math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat)]
    signs = np.cross(vertices, np.roll(vertices, -1, axis=0)) @ point
    return bool(np.all(signs >= -1e-12) or np.all(signs <= 1e-12))


class Archive:
    def __init__(self, cache, fetch=get_remote):
        self.cache = cache
        self.fetch = fetch
        self.discovery_lock = threading.Lock()

    def collections(self, force=False):
        with self.discovery_lock:
            cached = self.cache.get("collections")
            if cached and not force and time.time() - cached[0] < 86400 * 7:
                return cached[1]
            try:
                root = ET.fromstring(self.fetch(SIA_URL, {"MAXREC": 0}))
                names = []
                for param in root.iter():
                    if param.tag.endswith("PARAM") and param.get("name") == "COLLECTION":
                        names = [o.get("value") for o in param.iter() if o.tag.endswith("OPTION")]
                names = sorted(n for n in names if n and re.fullmatch(r"spherex_(?:dr|qr)\d+(?:_deep)?", n))
                if not names:
                    raise ArchiveError("SIA metadata did not advertise any SPHEREx spectral image collections")
                self.cache.put("collections", names)
                return names
            except Exception:
                if cached and not force:
                    return cached[1]
                raise

    def search(self, ra, dec, fov, window, release):
        collections = self.collections()
        if release != "auto":
            collections = [name for name in collections if name == release or name == release + "_deep"]
            if not collections:
                raise ValueError("Requested release is not advertised by the live SIA service")
        now = Time.now().mjd
        params = [("COLLECTION", name) for name in collections]
        # find exposures containing the center; the IBE request and output WCS set the displayed FOV.
        params += [("POS", f"CIRCLE {ra:.7f} {dec:.7f} 0"),
                   ("TIME", f"{now - window * 365.25:.5f} {now:.5f}"),
                   ("DPTYPE", "image"), ("MAXREC", 10000)]
        search_key = "search:" + hashlib.sha256(json.dumps([ra, dec, window, collections]).encode()).hexdigest()
        cached = self.cache.get(search_key)
        if cached is None:
            alt_key = "search:" + hashlib.sha256(json.dumps([round(float(ra) % 360, 6), round(float(dec), 6), round(float(window), 3), collections]).encode()).hexdigest()
            cached = self.cache.get(alt_key)
        if cached and time.time() - cached[0] < 86400 * 7:
            return cached[1], collections
        try:
            rows, overflow = read_votable(self.fetch(SIA_URL, params))
            if overflow:
                raise ArchiveError("SIA result exceeded 10,000 images; choose a smaller field or time window")
            self.cache.put(search_key, rows)
            return rows, collections
        except ArchiveError:
            raise
        except Exception:
            if cached:
                return cached[1], collections
            raise

    def cutout(self, row, ra, dec, fov):
        url = row["access_url"]
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname != "irsa.ipac.caltech.edu" or not parsed.path.startswith("/ibe/data/spherex/"):
            raise ArchiveError("SIA returned an unsupported cutout URL")
        native_fov = 600 * 2 ** max(0, math.ceil(math.log2(fov / 600)))
        params = {"center": f"{ra:.7f},{dec:.7f}", "size": f"{native_fov * math.sqrt(2) / 3600:.9f}", "gzip": "false"}
        key = "cutout:" + hashlib.sha256(json.dumps([CACHE_VERSION, url, params, fov]).encode()).hexdigest()
        cached = self.cache.get(key)
        if cached:
            return cached[1]
        raw_key = "fits:" + hashlib.sha256(json.dumps([url, params]).encode()).hexdigest()
        raw_cached = self.cache.get(raw_key)
        raw = base64.b64decode(raw_cached[1]) if raw_cached else self.fetch(url, params)
        with fits.open(io.BytesIO(raw), memmap=False) as hdus:
            hdu = hdus["IMAGE"]
            unit = hdu.header.get("BUNIT", "").replace(" ", "").lower()
            if unit != "mjy/sr":
                raise ArchiveError(f"Unsupported SPHEREx image unit: {unit}")
            source_wcs = WCS(hdu.header, hdus).celestial
            wave_header = hdu.header.copy()
            for keyword in list(wave_header):
                if re.fullmatch(r"(?:A|B|AP|BP)_(?:ORDER|\d+_\d+)", keyword):
                    del wave_header[keyword]
            wave_wcs = WCS(wave_header, hdus, key="W")
            if raw_cached is None:
                compact = io.BytesIO()
                fits.HDUList([fits.PrimaryHDU(), hdus["IMAGE"].copy(), hdus["FLAGS"].copy(),
                              hdus["WCS-WAVE"].copy()] if "WCS-WAVE" in hdus else
                             [fits.PrimaryHDU(), hdus["IMAGE"].copy(), hdus["FLAGS"].copy()]).writeto(compact)
                self.cache.put(raw_key, base64.b64encode(compact.getvalue()).decode("ascii"))
            target_wcs = display_wcs(ra, dec, fov)
            yy, xx = np.mgrid[:GRID_SIZE, :GRID_SIZE]
            world = target_wcs.pixel_to_world(xx, yy)
            sx, sy = source_wcs.world_to_pixel(world)
            image = np.asarray(hdu.data, dtype=float)
            flag_image = np.asarray(hdus["FLAGS"].data, dtype=np.uint32)
            # nearest-neighbour sampling preserves measured values and discrete flags for this preview.
            plane = map_coordinates(image, [sy, sx], order=0, mode="constant", cval=np.nan)
            flags = map_coordinates(flag_image, [sy, sx], order=0, mode="constant", cval=1 << 9)
            bad_bits = sum(1 << bit for bit in (1, 2, 6, 7, 9, 10, 11, 15))
            plane[(flags & bad_bits) != 0] = np.nan
            # the celestial transform already inverted SIP; spectral lookup uses detector pixels directly.
            wave_plane, band_plane = wave_wcs.wcs_pix2world(sx, sy, 0)
            cx, cy = source_wcs.world_to_pixel_values(ra, dec)
            wavelength, bandwidth, value = None, None, None
            if 0 <= cx < image.shape[1] and 0 <= cy < image.shape[0]:
                wave, band = wave_wcs.wcs_pix2world(float(cx), float(cy), 0)
                if np.isfinite(wave) and np.isfinite(band):
                    wavelength, bandwidth = float(wave), float(band)
                ix, iy = min(round(float(cx)), image.shape[1] - 1), min(round(float(cy)), image.shape[0] - 1)
                if np.isfinite(image[iy, ix]) and not (flag_image[iy, ix] & bad_bits):
                    value = float(image[iy, ix])
            if not np.any(np.isfinite(plane)):
                raise ArchiveError("Cutout has no valid pixels in the requested field")
            result = {"frame": encoded(plane), "flags": encoded(flags, "<u4"),
                      "wavelength_map": encoded(wave_plane), "bandwidth_map": encoded(band_plane),
                      "detector": int(hdu.header["DETECTOR"]), "mjd": float(hdu.header["MJD-OBS"]),
                      "obs_id": str(hdu.header["OBSID"]), "collection": row["obs_collection"],
                      "access_url": url, "wavelength_um": wavelength, "bandwidth_um": bandwidth,
                      "center_brightness": value}
        self.cache.put(key, result)
        return result

    def catalogs(self, ra, dec, fov):
        queries = {
            "gaia": ("gaia_dr3_source", "source_id,ra,dec,ref_epoch,pmra,pmdec,phot_g_mean_mag"),
            "wise": ("allwise_p3as_psd", "designation,ra,dec,w1mpro,w2mpro"),
        }
        results, errors = {}, {}
        for kind, (catalog, columns) in queries.items():
            params = {"catalog": catalog, "spatial": "Cone", "objstr": f"{ra:.7f} {dec:.7f}",
                      "radius": fov / math.sqrt(2), "radunits": "arcsec", "outfmt": 3,
                      "selcols": columns, "outrows": 1000}
            key = "catalog:" + hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest()
            cached = self.cache.get(key)
            if cached and time.time() - cached[0] < 86400 * 7:
                rows = list(cached[1])
            else:
                try:
                    rows, overflow = read_votable(self.fetch("https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query", params))
                    self.cache.put(key, rows)
                    if overflow or len(rows) == 1000:
                        errors[kind] = "Catalog display limited to 1,000 sources"
                except Exception as exc:
                    rows = list(cached[1]) if cached else []
                    errors[kind] = str(exc)
            if fov > 300:
                inner_params = dict(params, radius=300 / math.sqrt(2))
                inner_key = "catalog:" + hashlib.sha256(json.dumps(inner_params, sort_keys=True).encode()).hexdigest()
                inner_cached = self.cache.get(inner_key)
                if inner_cached:
                    id_field = "source_id" if kind == "gaia" else "designation"
                    seen = {str(r.get(id_field)) for r in rows}
                    for inner_row in inner_cached[1]:
                        if str(inner_row.get(id_field)) not in seen:
                            rows.append(inner_row)
                            seen.add(str(inner_row.get(id_field)))
            results[kind] = rows
        sources = []
        wcs = display_wcs(ra, dec, fov)
        for kind, rows in results.items():
            for row in rows:
                px, py = wcs.world_to_pixel_values(row["ra"], row["dec"])
                in_box = -1 <= px < GRID_SIZE and -1 <= py < GRID_SIZE
                if not in_box and kind == "gaia":
                    prop_ra, prop_dec = propagate_gaia_radec(
                        row["ra"], row["dec"], row.get("pmra"), row.get("pmdec"), row.get("ref_epoch"), 2026.5
                    )
                    ppx, ppy = wcs.world_to_pixel_values(prop_ra, prop_dec)
                    in_box = -1 <= ppx < GRID_SIZE and -1 <= ppy < GRID_SIZE
                if not in_box:
                    continue
                name = str(row.get("source_id", row.get("designation")))
                sources.append({"id": f"{kind}:{name}", "name": name, "kind": "Gaia DR3" if kind == "gaia" else "AllWISE",
                                "ra": row["ra"], "dec": row["dec"], "px": float(px + 0.5), "py": float(py + 0.5),
                                "pmra_mas_yr": row.get("pmra") or 0, "pmdec_mas_yr": row.get("pmdec") or 0,
                                "reference_epoch": row.get("ref_epoch"), "gaia": row if kind == "gaia" else None,
                                "wise": row if kind == "wise" else None})
        return sources, errors

    def build_sky(self, config, ra, dec, fov, window, release, progress=None):
        report = progress or (lambda **kwargs: None)
        report(phase="discovery", completed=0, total=0)
        rows, collections = self.search(ra, dec, fov, window, release)
        # prefer the newest processing of each exposure before sampling observations.
        unique = {}
        for row in rows:
            detector = detector_number(row)
            if detector and row.get("t_min") is not None:
                key = (row.get("obs_id"), detector)
                previous = unique.get(key)
                if previous is None or row["access_url"].split("_spx_")[-1] > previous["access_url"].split("_spx_")[-1]:
                    unique[key] = row
        selected = []
        for detector in range(1, 7):
            candidates = sorted((r for r in unique.values() if detector_number(r) == detector), key=lambda r: r["t_min"])
            centered = [r for r in candidates if covers_center(r, ra, dec)]
            if centered:
                candidates = centered
            if candidates:
                selected.append(candidates[0])
                if len(candidates) > 1:
                    selected.append(candidates[-1])
        if not selected:
            return dict(empty_sky(config, ra, dec, fov, window, release), data_status="empty",
                        message="No data found for this field, release and time window. Try another location or release.",
                        provenance={"sia_url": SIA_URL, "collections": collections, "matched_images": len(unique), "queried_at": Time.now().isot + "Z"})
        cutouts, failures = [], []
        report(phase="cutouts", completed=0, total=len(selected))
        with ThreadPoolExecutor(max_workers=3) as pool:
            catalog_future = pool.submit(self.catalogs, ra, dec, fov)
            futures = {pool.submit(self.cutout, row, ra, dec, fov): row for row in selected}
            for future in as_completed(futures):
                row = futures[future]
                try:
                    cutouts.append(future.result())
                except Exception as exc:
                    failures.append({"url": row["access_url"], "error": str(exc)})
                report(phase="cutouts", completed=len(cutouts)+len(failures), total=len(selected))
            report(phase="catalogs", completed=len(selected), total=len(selected))
            sources, catalog_errors = catalog_future.result()
        if selected and not cutouts:
            raise ArchiveError("No selected cutout could be displayed: " + failures[0]["error"])
        cutouts.sort(key=lambda c: c["mjd"])
        payload = empty_sky(config, ra, dec, fov, window, release)
        frames = np.full((len(cutouts), 6, GRID_SIZE, GRID_SIZE), np.nan, dtype=np.float32)
        flags = np.zeros((len(cutouts), GRID_SIZE, GRID_SIZE), dtype=np.uint32)
        wavelength_maps = np.full_like(flags, np.nan, dtype=np.float32)
        bandwidth_maps = np.full_like(flags, np.nan, dtype=np.float32)
        epochs, measurements = [], []
        for idx, cutout in enumerate(cutouts):
            detector = cutout["detector"] - 1
            frames[idx, detector] = np.frombuffer(base64.b64decode(cutout["frame"]), dtype="<f4").reshape(GRID_SIZE, GRID_SIZE)
            flags[idx] = np.frombuffer(base64.b64decode(cutout["flags"]), dtype="<u4").reshape(GRID_SIZE, GRID_SIZE)
            wavelength_maps[idx] = np.frombuffer(base64.b64decode(cutout["wavelength_map"]), dtype="<f4").reshape(GRID_SIZE, GRID_SIZE)
            bandwidth_maps[idx] = np.frombuffer(base64.b64decode(cutout["bandwidth_map"]), dtype="<f4").reshape(GRID_SIZE, GRID_SIZE)
            epoch_time = Time(cutout["mjd"], format="mjd")
            wave_um = cutout["wavelength_um"]
            band_um = cutout["bandwidth_um"]
            brightness = cutout["center_brightness"]
            aperture_px = 0.0
            if wave_um is None or brightness is None or not math.isfinite(wave_um) or not math.isfinite(brightness):
                wave_um, band_um, brightness, aperture_px = aperture_sample(
                    frames[idx, detector], wavelength_maps[idx], bandwidth_maps[idx]
                )
            epochs.append({"index": idx, "year": float(epoch_time.decimalyear), "mjd": cutout["mjd"],
                           "label": epoch_time.isot[:10] + f" D{detector + 1}",
                           "source": cutout["collection"], "detectors": [detector + 1],
                           "wavelength_um": wave_um, "bandwidth_um": band_um})
            if wave_um is not None and brightness is not None and math.isfinite(wave_um) and math.isfinite(brightness):
                measurements.append({"wavelength_um": wave_um, "brightness": brightness,
                                     "detector": detector, "mjd": cutout["mjd"], "aperture_px": aperture_px})
        measurements.sort(key=lambda m: m["wavelength_um"])
        spectral_fft = resample_spectral_grid(measurements)
        payload.update({"epochs": epochs, "frames_b64": encoded(frames), "flags_b64": encoded(flags, "<u4"),
                        "wavelength_maps_b64": encoded(wavelength_maps), "bandwidth_maps_b64": encoded(bandwidth_maps),
                        "sources": sources, "measurements": measurements, "spectral_fft": spectral_fft,
                        "fft_unavailable": None if spectral_fft else payload["fft_unavailable"],
                        "data_status": "ready" if cutouts else "empty",
                        "message": f"{len(cutouts)} observed cutouts / {len(unique)} matching images · MJy/sr" if cutouts else "No SPHEREx images in this field and time window",
                        "provenance": {"sia_url": SIA_URL, "collections": collections, "matched_images": len(unique),
                                       "search_scope": "exposures containing the field center; not a complete FOV mosaic",
                                       "selection": "earliest and latest exposure per detector; preview subset",
                                       "images": [{k: v for k, v in c.items() if k not in ("frame", "flags", "wavelength_map", "bandwidth_map")} for c in cutouts],
                                       "cutout_errors": failures, "catalog_errors": catalog_errors,
                                       "queried_at": Time.now().isot + "Z"}})
        return payload


def empty_sky(config, ra, dec, fov, window, release):
    return {"release": {"id": release}, "ra": ra, "dec": dec, "fov": fov, "window": window,
            "grid_size": GRID_SIZE, "pixel_scale_arcsec": fov / GRID_SIZE,
            "detectors": config["detectors"], "epochs": [], "sources": [], "flag_events": [],
            "frames_b64": "", "flags_b64": "", "wavelength_maps_b64": "", "bandwidth_maps_b64": "", "measurements": [],
            "spectral_fft": None, "data_status": "loading", "message": "Loading live IRSA cutouts…",
            "fft_unavailable": "FFT needs a uniformly sampled spectrum; these cutouts are sparse, unequal-wavelength observations."}
