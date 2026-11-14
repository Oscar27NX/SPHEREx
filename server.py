import base64
import hashlib
import importlib.util
import json
import math
import os
import threading
import time
from collections import OrderedDict
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
import requests
from scipy import fft as sp_fft

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RELEASES_PATH = os.path.join(BASE_DIR, "releases.json")
GRID_SIZE = 64
NUM_BANDS = 102
NUM_DETECTORS = 6
CACHE_LIMIT = 256

HAS_ASTROQUERY = (
    importlib.util.find_spec("astroquery") is not None
    and importlib.util.find_spec("astroquery.ipac.irsa") is not None
)
HAS_ASTROPY = importlib.util.find_spec("astropy") is not None


def load_config():
    with open(RELEASES_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def build_wavelength_grid(detectors):
    wavelengths = []
    det_index = []
    for idx, det in enumerate(detectors):
        n_ch = int(det["channels"])
        grid = np.linspace(det["lambda_min_um"], det["lambda_max_um"], n_ch, dtype=np.float64)
        wavelengths.append(grid)
        det_index.extend([idx] * n_ch)
    return np.concatenate(wavelengths), np.array(det_index, dtype=np.int32)


def blackbody_normalized(lam_um, temp_k):
    h_c_k = 14387.7688
    exponent = np.clip(h_c_k / (np.maximum(lam_um, 0.1) * max(temp_k, 100.0)), 1e-3, 80.0)
    raw = (1.0 / np.maximum(lam_um, 0.1) ** 3) / np.expm1(exponent)
    peak = np.max(raw)
    return raw / peak if peak > 0 else raw


def build_source_spectrum(kind, lam_um, rng):
    if kind == "Moving Brown Dwarf":
        cont = blackbody_normalized(lam_um, rng.uniform(450.0, 950.0))
        ch4_dip = 1.0 - 0.62 * np.exp(-0.5 * ((lam_um - 1.66) / 0.08) ** 2)
        ch4_dip2 = 1.0 - 0.72 * np.exp(-0.5 * ((lam_um - 2.25) / 0.12) ** 2)
        ch4_dip3 = 1.0 - 0.85 * np.exp(-0.5 * ((lam_um - 3.35) / 0.16) ** 2)
        h2o_dip = 1.0 - 0.55 * np.exp(-0.5 * ((lam_um - 2.75) / 0.22) ** 2)
        co_dip = 1.0 - 0.48 * np.exp(-0.5 * ((lam_um - 4.65) / 0.14) ** 2)
        flux = (0.35 + 1.45 * cont) * ch4_dip * ch4_dip2 * ch4_dip3 * h2o_dip * co_dip
    elif kind == "YSO Ice Core":
        cont = blackbody_normalized(lam_um, rng.uniform(700.0, 1400.0)) * (lam_um / 2.0) ** 0.7
        h2o_ice = 1.0 - 0.68 * np.exp(-0.5 * ((lam_um - 3.05) / 0.18) ** 2)
        co2_ice = 1.0 - 0.76 * np.exp(-0.5 * ((lam_um - 4.27) / 0.055) ** 2)
        co_ice = 1.0 - 0.52 * np.exp(-0.5 * ((lam_um - 4.67) / 0.04) ** 2)
        flux = (0.5 + 1.8 * cont) * h2o_ice * co2_ice * co_ice
    elif kind == "Starburst Galaxy":
        cont = blackbody_normalized(lam_um, rng.uniform(1800.0, 3200.0))
        pah_33 = 0.95 * np.exp(-0.5 * ((lam_um - 3.29) / 0.045) ** 2)
        pah_34 = 0.35 * np.exp(-0.5 * ((lam_um - 3.41) / 0.04) ** 2)
        p_alpha = 0.55 * np.exp(-0.5 * ((lam_um - 1.875) / 0.03) ** 2)
        br_alpha = 0.45 * np.exp(-0.5 * ((lam_um - 4.051) / 0.03) ** 2)
        flux = 0.65 * cont + pah_33 + pah_34 + p_alpha + br_alpha + 0.15 * (lam_um / 5.0)
    else:
        temp = rng.uniform(2800.0, 6200.0)
        cont = blackbody_normalized(lam_um, temp)
        co_band = 1.0 - 0.18 * np.exp(-0.5 * ((lam_um - 2.31) / 0.06) ** 2)
        flux = (0.4 + 2.2 * cont) * co_band
    noise = rng.normal(0.0, 0.025, size=lam_um.shape)
    return np.clip(flux + noise, 0.02, None)


def compute_spectral_fft(spectrum_102):
    arr = np.asarray(spectrum_102, dtype=np.float64)
    coeffs = sp_fft.rfft(arr)
    n_k = coeffs.shape[0]
    k_idx = np.arange(n_k)

    # split spectral frequency modes into continuum, molecular features, and narrow lines
    low_mask = k_idx <= 6
    mid_mask = (k_idx >= 3) & (k_idx <= 20)
    high_mask = k_idx >= 12

    low_rec = sp_fft.irfft(coeffs * low_mask, n=arr.size)
    mid_rec = sp_fft.irfft(coeffs * mid_mask, n=arr.size)
    high_rec = sp_fft.irfft(coeffs * high_mask, n=arr.size)
    denoised = sp_fft.irfft(coeffs * (k_idx <= 24), n=arr.size)

    return {
        "fft_power_52": np.round(np.abs(coeffs), 5).tolist(),
        "fft_bands": {
            "low": np.round(low_rec, 5).tolist(),
            "mid": np.round(mid_rec, 5).tolist(),
            "high": np.round(high_rec, 5).tolist(),
            "denoised": np.round(denoised, 5).tolist(),
        },
    }


def cell_seed(ix, iy):
    digest = hashlib.sha256(f"spherex-cell:{ix}:{iy}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "little")


def generate_patch_sources(ix, iy, cell_deg, lam_um):
    rng = np.random.default_rng(cell_seed(ix, iy))
    ra_base = (ix * cell_deg) % 360.0
    dec_base = iy * cell_deg
    if dec_base < -89.5 or dec_base > 89.5:
        return []

    sources = []
    n_static = int(rng.integers(8, 15))
    kinds = ["Field Star", "Field Star", "Field Star", "Starburst Galaxy", "YSO Ice Core"]
    for idx in range(n_static):
        kind = kinds[int(rng.integers(0, len(kinds)))]
        ra = (ra_base + rng.uniform(0.02, 0.98) * cell_deg) % 360.0
        dec = float(np.clip(dec_base + rng.uniform(0.02, 0.98) * cell_deg, -89.8, 89.8))
        pmra = float(rng.normal(0.0, 12.0))
        pmdec = float(rng.normal(0.0, 12.0))
        amp = float(rng.uniform(1.2, 7.5))
        spec = build_source_spectrum(kind, lam_um, rng) * amp
        gmag = float(np.clip(20.5 - 1.7 * math.log1p(amp), 10.5, 21.2))
        w1 = float(np.clip(17.2 - 1.4 * math.log1p(amp), 8.2, 18.0))
        w2 = float(w1 - rng.uniform(-0.1, 0.45))
        sources.append({
            "id": f"SPX-{ix}_{iy}-{idx}",
            "name": f"{kind[:4].upper()} J{ra:06.2f}{dec:+06.2f}",
            "kind": kind,
            "ra": ra,
            "dec": dec,
            "pmra_mas_yr": round(pmra, 2),
            "pmdec_mas_yr": round(pmdec, 2),
            "amplitude": round(amp, 3),
            "spectrum_102": np.round(spec, 4),
            "gaia": {
                "source_id": f"GaiaDR3-{abs(ix * 7919 + iy * 104729 + idx)}",
                "gmag": round(gmag, 2),
                "pmra": round(pmra, 2),
                "pmdec": round(pmdec, 2),
            } if gmag < 20.6 else None,
            "wise": {
                "designation": f"J{ra:06.2f}{dec:+06.2f}",
                "w1": round(w1, 2),
                "w2": round(w2, 2),
            },
        })

    n_movers = 1 if rng.random() < 0.72 else 2
    for m_idx in range(n_movers):
        ra = (ra_base + rng.uniform(0.15, 0.85) * cell_deg) % 360.0
        dec = float(np.clip(dec_base + rng.uniform(0.15, 0.85) * cell_deg, -89.0, 89.0))
        angle = rng.uniform(0.0, 2.0 * math.pi)
        speed_arcsec_yr = float(rng.uniform(2.2, 9.8))
        pmra = speed_arcsec_yr * 1000.0 * math.cos(angle)
        pmdec = speed_arcsec_yr * 1000.0 * math.sin(angle)
        amp = float(rng.uniform(3.2, 8.8))
        spec = build_source_spectrum("Moving Brown Dwarf", lam_um, rng) * amp
        w2 = float(rng.uniform(12.2, 15.1))
        w1 = float(w2 + rng.uniform(1.6, 3.4))
        sources.append({
            "id": f"MOV-{ix}_{iy}-{m_idx}",
            "name": f"BDPM J{ra:06.2f}{dec:+06.2f}",
            "kind": "Moving Brown Dwarf",
            "ra": ra,
            "dec": dec,
            "pmra_mas_yr": round(pmra, 1),
            "pmdec_mas_yr": round(pmdec, 1),
            "amplitude": round(amp, 3),
            "spectrum_102": np.round(spec, 4),
            "gaia": None,
            "wise": {
                "designation": f"WISE J{ra:06.2f}{dec:+06.2f}",
                "w1": round(w1, 2),
                "w2": round(w2, 2),
            },
        })

    return sources


def inject_preset_anchors(ra, dec, fov_arcsec, config, lam_um):
    anchors = []
    fov_deg = fov_arcsec / 3600.0
    for idx, preset in enumerate(config.get("preset_targets", [])):
        d_ra = ((preset["ra"] - ra + 180.0) % 360.0) - 180.0
        d_dec = preset["dec"] - dec
        if abs(d_ra) <= fov_deg * 0.7 and abs(d_dec) <= fov_deg * 0.7:
            rng = np.random.default_rng(9001 + idx)
            if "Barnard" in preset["name"]:
                pmra, pmdec, kind = -798.6, 10328.1, "Field Star"
            elif "Luhman" in preset["name"]:
                pmra, pmdec, kind = -2760.0, 355.0, "Moving Brown Dwarf"
            elif "Taurus" in preset["name"]:
                pmra, pmdec, kind = 8.4, -19.2, "YSO Ice Core"
            elif "Deep Field" in preset["name"]:
                pmra, pmdec, kind = 0.0, 0.0, "Starburst Galaxy"
            else:
                pmra, pmdec, kind = -8051.0, 657.0, "Moving Brown Dwarf"
            spec = build_source_spectrum(kind, lam_um, rng) * 7.8
            anchors.append({
                "id": f"PRESET-{idx}",
                "name": preset["name"].split(" (")[0],
                "kind": kind,
                "ra": float(preset["ra"]),
                "dec": float(preset["dec"]),
                "pmra_mas_yr": pmra,
                "pmdec_mas_yr": pmdec,
                "amplitude": 7.8,
                "spectrum_102": np.round(spec, 4),
                "gaia": {
                    "source_id": f"GaiaDR3-Anchor-{idx}",
                    "gmag": 9.54 if "Barnard" in preset["name"] else 18.4,
                    "pmra": pmra,
                    "pmdec": pmdec,
                } if kind != "Moving Brown Dwarf" else None,
                "wise": {
                    "designation": preset["name"].split(" (")[0],
                    "w1": 13.9 if kind == "Moving Brown Dwarf" else 9.1,
                    "w2": 11.4 if kind == "Moving Brown Dwarf" else 8.9,
                },
            })
    return anchors


class SkyEngine:
    def __init__(self):
        self.config = load_config()
        self.lam_um, self.det_index = build_wavelength_grid(self.config["detectors"])
        self.det_slices = [np.where(self.det_index == d)[0] for d in range(NUM_DETECTORS)]
        self.cache = OrderedDict()
        self.patch_cache = OrderedDict()
        self.lock = threading.Lock()
        self.stats = {"hits": 0, "misses": 0, "prewarmed": 0}
        self._prewarm()

    def reload_config(self):
        with self.lock:
            self.config = load_config()
            self.lam_um, self.det_index = build_wavelength_grid(self.config["detectors"])
            self.det_slices = [np.where(self.det_index == d)[0] for d in range(NUM_DETECTORS)]
            self.cache.clear()
            self.patch_cache.clear()
        self._prewarm()

    def _prewarm(self):
        default_rel = self.config["default_release"]
        win = float(self.config.get("default_time_window_years", 10.0))
        targets = self.config.get("preset_targets", [])
        for target in targets:
            self.get_sky_cube(
                ra=float(target["ra"]),
                dec=float(target["dec"]),
                fov_arcsec=float(target.get("fov", 300.0)),
                window_years=win,
                release_id=default_rel,
            )
            self.stats["prewarmed"] += 1

    def _get_release(self, release_id):
        for rel in self.config["releases"]:
            if rel["id"] == release_id:
                return rel
        return self.config["releases"][0]

    def _get_patch(self, ix, iy, cell_deg):
        key = (ix, iy)
        with self.lock:
            if key in self.patch_cache:
                self.patch_cache.move_to_end(key)
                return self.patch_cache[key]
        sources = generate_patch_sources(ix, iy, cell_deg, self.lam_um)
        with self.lock:
            self.patch_cache[key] = sources
            if len(self.patch_cache) > 512:
                self.patch_cache.popitem(last=False)
        return sources

    def _collect_sources(self, ra, dec, fov_arcsec):
        cell_deg = 0.12
        half_deg = (fov_arcsec / 3600.0) * 0.72
        cos_dec = max(0.15, math.cos(math.radians(dec)))
        ra_span = half_deg / cos_dec

        iy_min = int(math.floor((dec - half_deg) / cell_deg))
        iy_max = int(math.floor((dec + half_deg) / cell_deg))
        n_ra_cells = int(round(360.0 / cell_deg))
        ix_start = int(math.floor(((ra - ra_span) % 360.0) / cell_deg))
        ix_steps = max(1, int(math.ceil((2.0 * ra_span) / cell_deg)) + 1)

        candidates = []
        for s_step in range(ix_steps):
            ix = (ix_start + s_step) % n_ra_cells
            for iy in range(iy_min, iy_max + 1):
                candidates.extend(self._get_patch(ix, iy, cell_deg))

        candidates.extend(inject_preset_anchors(ra, dec, fov_arcsec, self.config, self.lam_um))

        visible = []
        seen_coords = set()
        limit_deg = (fov_arcsec / 3600.0) * 0.54
        for src in candidates:
            d_ra = (((src["ra"] - ra + 180.0) % 360.0) - 180.0) * cos_dec
            d_dec = src["dec"] - dec
            if abs(d_ra) <= limit_deg and abs(d_dec) <= limit_deg:
                dedup_key = (round(src["ra"], 4), round(src["dec"], 4))
                if dedup_key in seen_coords:
                    continue
                seen_coords.add(dedup_key)
                visible.append(src)
        return visible

    def get_sky_cube(self, ra, dec, fov_arcsec=300.0, window_years=10.0, release_id=None):
        t0 = time.perf_counter()
        rel = self._get_release(release_id or self.config["default_release"])
        norm_ra = round(ra % 360.0, 5)
        norm_dec = round(float(np.clip(dec, -89.9, 89.9)), 5)
        norm_fov = float(np.clip(fov_arcsec, 60.0, 1800.0))
        norm_win = float(np.clip(window_years, 0.5, 15.0))
        key = (norm_ra, norm_dec, norm_fov, norm_win, rel["id"])

        with self.lock:
            if key in self.cache:
                self.cache.move_to_end(key)
                self.stats["hits"] += 1
                cached = dict(self.cache[key])
                cached["cache"] = "HIT"
                cached["server_ms"] = round((time.perf_counter() - t0) * 1000.0, 3)
                return cached

        self.stats["misses"] += 1
        payload = self._render_cube(norm_ra, norm_dec, norm_fov, norm_win, rel)
        with self.lock:
            self.cache[key] = payload
            if len(self.cache) > CACHE_LIMIT:
                self.cache.popitem(last=False)

        result = dict(payload)
        result["cache"] = "MISS"
        result["server_ms"] = round((time.perf_counter() - t0) * 1000.0, 3)
        return result

    def _render_cube(self, ra, dec, fov_arcsec, window_years, rel):
        n_epochs = 8
        end_yr = float(rel.get("epoch_end_year", 2026.0))
        start_yr = max(float(rel.get("epoch_start_year", 2016.0)), end_yr - window_years)
        years = np.linspace(start_yr, end_yr, n_epochs)
        ref_year = 0.5 * (start_yr + end_yr)

        epochs = []
        for idx, yr in enumerate(years):
            mjd = 51544.5 + (yr - 2000.0) * 365.25
            src_label = "WISE/NEOWISE Anchor" if yr < 2025.0 else rel["id"]
            epochs.append({
                "index": idx,
                "year": round(float(yr), 2),
                "mjd": round(float(mjd), 2),
                "label": f"{yr:.1f}",
                "source": src_label,
            })

        sources = self._collect_sources(ra, dec, fov_arcsec)
        px_scale = fov_arcsec / GRID_SIZE
        cos_dec = max(0.15, math.cos(math.radians(dec)))

        yy, xx = np.mgrid[0:GRID_SIZE, 0:GRID_SIZE].astype(np.float32)
        frames = np.zeros((n_epochs, NUM_DETECTORS, GRID_SIZE, GRID_SIZE), dtype=np.float32)
        flags = np.zeros((n_epochs, GRID_SIZE, GRID_SIZE), dtype=np.uint32)

        rng = np.random.default_rng(abs(int(round(ra * 1000.0)) * 73856093 ^ int(round((dec + 90.0) * 1000.0)) * 19349663))

        # compute per-detector band averages for fast spatially vectorized psf splatting
        det_weights = np.zeros((len(sources), NUM_DETECTORS), dtype=np.float32)
        for s_idx, src in enumerate(sources):
            spec = src["spectrum_102"]
            for d_idx, sl in enumerate(self.det_slices):
                det_weights[s_idx, d_idx] = float(np.mean(spec[sl]))

        zodi_base = np.array([0.42, 0.34, 0.28, 0.45, 0.62, 0.78], dtype=np.float32)
        sigma_px = np.clip(1.35 * (300.0 / fov_arcsec) ** 0.35, 0.85, 2.4)
        inv_2sig2 = np.float32(1.0 / (2.0 * sigma_px * sigma_px))

        flag_defs = {f["name"]: f for f in self.config["flags_bitmask"]}
        flag_events = []

        serialized_sources = []
        for s_idx, src in enumerate(sources):
            d_ra_0 = (((src["ra"] - ra + 180.0) % 360.0) - 180.0) * cos_dec * 3600.0
            d_dec_0 = (src["dec"] - dec) * 3600.0
            fft_info = compute_spectral_fft(src["spectrum_102"])

            px_mid = (GRID_SIZE * 0.5) - (d_ra_0 / px_scale)
            py_mid = (GRID_SIZE * 0.5) - (d_dec_0 / px_scale)
            serialized_sources.append({
                "id": src["id"],
                "name": src["name"],
                "kind": src["kind"],
                "ra": round(src["ra"], 6),
                "dec": round(src["dec"], 6),
                "px": round(float(px_mid), 2),
                "py": round(float(py_mid), 2),
                "pmra_mas_yr": src["pmra_mas_yr"],
                "pmdec_mas_yr": src["pmdec_mas_yr"],
                "gaia": src["gaia"],
                "wise": src["wise"],
                "spectrum_102": src["spectrum_102"].tolist(),
                "fft_power_52": fft_info["fft_power_52"],
                "fft_bands": fft_info["fft_bands"],
            })

            for e_idx, yr in enumerate(years):
                dt = yr - ref_year
                x_arcsec = d_ra_0 + (src["pmra_mas_yr"] * 0.001) * dt
                y_arcsec = d_dec_0 + (src["pmdec_mas_yr"] * 0.001) * dt
                cx = (GRID_SIZE * 0.5) - (x_arcsec / px_scale)
                cy = (GRID_SIZE * 0.5) - (y_arcsec / px_scale)
                if cx < -4 or cx > GRID_SIZE + 4 or cy < -4 or cy > GRID_SIZE + 4:
                    continue
                psf = np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) * inv_2sig2)
                frames[e_idx] += det_weights[s_idx][:, None, None] * psf[None, :, :]
                ix_c, iy_c = int(round(cx)), int(round(cy))
                if 0 <= ix_c < GRID_SIZE and 0 <= iy_c < GRID_SIZE:
                    flags[e_idx, iy_c, ix_c] |= np.uint32(1 << 21)

        for e_idx in range(n_epochs):
            for d_idx in range(NUM_DETECTORS):
                bg = zodi_base[d_idx] + rng.normal(0.0, 0.09, size=(GRID_SIZE, GRID_SIZE)).astype(np.float32)
                frames[e_idx, d_idx] += bg

            # inject realistic transient cosmic rays and satellite streaks into flags bitmask
            cr_x = int(rng.integers(4, GRID_SIZE - 4))
            cr_y = int(rng.integers(4, GRID_SIZE - 4))
            frames[e_idx, :, cr_y, cr_x] += np.float32(4.5)
            flags[e_idx, cr_y, cr_x] |= np.uint32(1 << 0)
            f_tr = flag_defs["TRANSIENT"]
            flag_events.append({
                "epoch": e_idx,
                "x": cr_x,
                "y": cr_y,
                "bit": f_tr["bit"],
                "name": f_tr["name"],
                "label": f_tr["label"],
                "color": f_tr["color"],
            })

            if e_idx in (2, 5):
                sy = int(rng.integers(8, GRID_SIZE - 8))
                sx_vals = np.arange(6, GRID_SIZE - 6)
                frames[e_idx, 1:4, sy, sx_vals] += np.float32(0.85)
                flags[e_idx, sy, sx_vals] |= np.uint32(1 << 24)
                f_st = flag_defs["STREAK"]
                flag_events.append({
                    "epoch": e_idx,
                    "x": int(GRID_SIZE // 2),
                    "y": sy,
                    "bit": f_st["bit"],
                    "name": f_st["name"],
                    "label": f_st["label"],
                    "color": f_st["color"],
                })

            if e_idx == 4:
                gx, gy = int(rng.integers(10, GRID_SIZE - 10)), int(rng.integers(10, GRID_SIZE - 10))
                frames[e_idx, 4:, max(0, gy - 1):min(GRID_SIZE, gy + 2), max(0, gx - 1):min(GRID_SIZE, gx + 2)] += np.float32(1.4)
                flags[e_idx, gy, gx] |= np.uint32(1 << 22)
                f_gh = flag_defs["GHOST"]
                flag_events.append({
                    "epoch": e_idx,
                    "x": gx,
                    "y": gy,
                    "bit": f_gh["bit"],
                    "name": f_gh["name"],
                    "label": f_gh["label"],
                    "color": f_gh["color"],
                })

        # compute two-dimensional fft spatial matched filter on six-detector snr coadd
        snr_coadd = np.mean(frames, axis=1)
        coadd_fft = np.empty_like(snr_coadd)
        fy = sp_fft.fftfreq(GRID_SIZE)[:, None]
        fx = sp_fft.fftfreq(GRID_SIZE)[None, :]
        lpf_2d = np.exp(-0.5 * ((fx ** 2 + fy ** 2) / (0.28 ** 2))).astype(np.float32)
        for e_idx in range(n_epochs):
            spec_2d = sp_fft.fft2(snr_coadd[e_idx])
            coadd_fft[e_idx] = np.real(sp_fft.ifft2(spec_2d * lpf_2d)).astype(np.float32)

        if serialized_sources:
            field_spec = np.mean([s["spectrum_102"] for s in serialized_sources], axis=0)
        else:
            field_spec = np.ones(NUM_BANDS, dtype=np.float64) * 0.45
        field_fft = compute_spectral_fft(field_spec)

        return {
            "release": rel,
            "ra": ra,
            "dec": dec,
            "fov": fov_arcsec,
            "window": window_years,
            "grid_size": GRID_SIZE,
            "pixel_scale_arcsec": round(px_scale, 3),
            "wavelengths_um": np.round(self.lam_um, 4).tolist(),
            "detector_index_102": self.det_index.tolist(),
            "detectors": self.config["detectors"],
            "epochs": epochs,
            "frames_b64": base64.b64encode(np.ascontiguousarray(frames, dtype="<f4").tobytes()).decode("ascii"),
            "coadd_fft_b64": base64.b64encode(np.ascontiguousarray(coadd_fft, dtype="<f4").tobytes()).decode("ascii"),
            "flags_b64": base64.b64encode(np.ascontiguousarray(flags, dtype="<u4").tobytes()).decode("ascii"),
            "flag_events": flag_events,
            "sources": serialized_sources,
            "field_spectrum_102": np.round(field_spec, 4).tolist(),
            "field_fft_power_52": field_fft["fft_power_52"],
            "field_fft_bands": field_fft["fft_bands"],
        }

    def query_irsa_live(self, ra, dec, fov_arcsec, release):
        if HAS_ASTROQUERY:
            try:
                from astroquery.ipac.irsa import Irsa
                from astropy.coordinates import SkyCoord
                import astropy.units as u
                coord = SkyCoord(ra=ra, dec=dec, unit=(u.deg, u.deg), frame="icrs")
                table = Irsa.query_region(coord, catalog="spherex.plane", spatial="Cone", radius=(fov_arcsec / 3600.0) * u.deg)
                return {
                    "attempted": True,
                    "via": "astroquery.ipac.irsa",
                    "status": "ok",
                    "rows": len(table),
                }
            except Exception as exc:
                return {
                    "attempted": True,
                    "via": "astroquery.ipac.irsa",
                    "status": f"fallback ({type(exc).__name__})",
                    "rows": 0,
                }

        adql = (
            f"SELECT TOP 12 p.planeid, p.energy_bandpassname, p.time_bounds_lower, a.uri "
            f"FROM {release['table_artifact']} a JOIN {release['table_plane']} p ON a.planeid = p.planeid "
            f"WHERE 1 = CONTAINS(POINT('ICRS', {ra:.5f}, {dec:.5f}), p.poly)"
        )
        try:
            resp = requests.get(
                release["tap_url"],
                params={"QUERY": adql, "FORMAT": "json"},
                timeout=1.5,
            )
            if resp.ok:
                data = resp.json()
                return {
                    "attempted": True,
                    "via": "irsa_tap_rest",
                    "status": "ok",
                    "rows": len(data.get("data", [])),
                    "sample": data.get("data", [])[:5],
                }
            return {
                "attempted": True,
                "via": "irsa_tap_rest",
                "status": f"http_{resp.status_code}",
                "rows": 0,
            }
        except Exception as exc:
            return {
                "attempted": True,
                "via": "irsa_tap_rest",
                "status": f"fallback ({type(exc).__name__})",
                "rows": 0,
            }


ENGINE = SkyEngine()


class SpherexHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def log_message(self, format, *args):
        return

    def _send_json(self, obj, status=HTTPStatus.OK):
        raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        if parsed.path == "/api/state":
            t0 = time.perf_counter()
            default_target = ENGINE.config["preset_targets"][0]
            sky = ENGINE.get_sky_cube(
                ra=float(default_target["ra"]),
                dec=float(default_target["dec"]),
                fov_arcsec=float(default_target.get("fov", 300.0)),
                window_years=float(ENGINE.config.get("default_time_window_years", 10.0)),
                release_id=ENGINE.config["default_release"],
            )
            self._send_json({
                "config": ENGINE.config,
                "initial_sky": sky,
                "capabilities": {
                    "astroquery_ipac_irsa": HAS_ASTROQUERY,
                    "astropy": HAS_ASTROPY,
                    "scipy_fft": True,
                },
                "cache_stats": dict(ENGINE.stats, cached_cubes=len(ENGINE.cache)),
                "server_ms": round((time.perf_counter() - t0) * 1000.0, 3),
            })
            return

        if parsed.path == "/api/sky":
            default_target = ENGINE.config["preset_targets"][0]
            ra = float(qs.get("ra", [default_target["ra"]])[0])
            dec = float(qs.get("dec", [default_target["dec"]])[0])
            fov = float(qs.get("fov", [default_target.get("fov", 300.0)])[0])
            window = float(qs.get("window", [ENGINE.config.get("default_time_window_years", 10.0)])[0])
            release_id = qs.get("release", [ENGINE.config["default_release"]])[0]
            live = qs.get("live", ["0"])[0] == "1"

            sky = ENGINE.get_sky_cube(ra=ra, dec=dec, fov_arcsec=fov, window_years=window, release_id=release_id)
            if live:
                sky["irsa_live"] = ENGINE.query_irsa_live(ra, dec, fov, sky["release"])
            else:
                sky["irsa_live"] = {
                    "attempted": False,
                    "astroquery_installed": HAS_ASTROQUERY,
                    "astropy_installed": HAS_ASTROPY,
                    "status": "cached_fast_path",
                }
            self._send_json(sky)
            return

        if parsed.path == "/api/catalogs":
            ra = float(qs.get("ra", [133.7867])[0])
            dec = float(qs.get("dec", [-7.2442])[0])
            fov = float(qs.get("fov", [300.0])[0])
            sky = ENGINE.get_sky_cube(ra=ra, dec=dec, fov_arcsec=fov)
            gaia = [s for s in sky["sources"] if s["gaia"] is not None]
            wise = [s for s in sky["sources"] if s["wise"] is not None]
            self._send_json({
                "ra": sky["ra"],
                "dec": sky["dec"],
                "fov": sky["fov"],
                "gaia_count": len(gaia),
                "wise_count": len(wise),
                "gaia": gaia,
                "wise": wise,
                "server_ms": sky["server_ms"],
                "cache": sky["cache"],
            })
            return

        if parsed.path == "/api/spectrum":
            ra = float(qs.get("ra", [133.7867])[0])
            dec = float(qs.get("dec", [-7.2442])[0])
            fov = float(qs.get("fov", [300.0])[0])
            px = float(qs.get("px", [GRID_SIZE * 0.5])[0])
            py = float(qs.get("py", [GRID_SIZE * 0.5])[0])
            sky = ENGINE.get_sky_cube(ra=ra, dec=dec, fov_arcsec=fov)
            nearest = None
            best_d2 = 1e9
            for src in sky["sources"]:
                d2 = (src["px"] - px) ** 2 + (src["py"] - py) ** 2
                if d2 < best_d2:
                    best_d2 = d2
                    nearest = src
            if nearest is not None and best_d2 <= 36.0:
                self._send_json({"source": nearest, "matched": True, "server_ms": sky["server_ms"]})
            else:
                self._send_json({
                    "source": {
                        "id": "SKY-BG",
                        "name": f"Sky ({px:.1f}, {py:.1f})",
                        "kind": "Zodiacal + Diffuse Sky",
                        "spectrum_102": sky["field_spectrum_102"],
                        "fft_power_52": sky["field_fft_power_52"],
                        "fft_bands": sky["field_fft_bands"],
                    },
                    "matched": False,
                    "server_ms": sky["server_ms"],
                })
            return

        if parsed.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/batch":
            t0 = time.perf_counter()
            body = self._read_json_body()
            queries = body.get("queries", [])[:24]
            results = []
            for q in queries:
                results.append(
                    ENGINE.get_sky_cube(
                        ra=float(q.get("ra", 133.7867)),
                        dec=float(q.get("dec", -7.2442)),
                        fov_arcsec=float(q.get("fov", 300.0)),
                        window_years=float(q.get("window", 10.0)),
                        release_id=q.get("release"),
                    )
                )
            self._send_json({
                "count": len(results),
                "results": results,
                "server_ms": round((time.perf_counter() - t0) * 1000.0, 3),
            })
            return

        if parsed.path == "/api/releases/reload":
            ENGINE.reload_config()
            self._send_json({"status": "reloaded", "releases": ENGINE.config["releases"]})
            return

        if parsed.path == "/api/releases":
            body = self._read_json_body()
            rel_id = body.get("id")
            if not rel_id:
                self._send_json({"error": "missing release id"}, status=HTTPStatus.BAD_REQUEST)
                return
            cfg = load_config()
            existing_ids = {r["id"] for r in cfg["releases"]}
            if rel_id not in existing_ids:
                cfg["releases"].insert(0, body)
                cfg["default_release"] = rel_id
                with open(RELEASES_PATH, "w", encoding="utf-8") as fh:
                    json.dump(cfg, fh, indent=2)
                ENGINE.reload_config()
            self._send_json({"status": "registered", "default_release": cfg["default_release"], "releases": cfg["releases"]})
            return

        self._send_json({"error": "not found"}, status=HTTPStatus.NOT_FOUND)


def main():
    port = int(os.environ.get("SPHEREX_PORT", "8080"))
    server = ThreadingHTTPServer(("127.0.0.1", port), SpherexHandler)
    server.daemon_threads = True
    print(f"SPHEREx server listening on http://127.0.0.1:{port} (prewarmed={ENGINE.stats['prewarmed']})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
