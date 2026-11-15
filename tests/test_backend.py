import base64
import io
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from astropy.time import Time

from archive import Archive, ArchiveError, DiskCache, aperture_sample, compute_spectral_fft, covers_center, display_wcs, empty_sky, encoded, propagate_gaia_radec, read_votable, resample_spectral_grid
from server import SkyEngine, cached_preview, load_config, normalize_query


class SpectrumTests(unittest.TestCase):
    def test_demo_filters_have_disjoint_known_components(self):
        i = np.arange(48)
        low = 3 + np.cos(2*np.pi*3*i/48)
        mid = .5*np.cos(2*np.pi*12*i/48)
        high = .25*np.cos(2*np.pi*20*i/48)
        result = compute_spectral_fft(low+mid+high, .9+i*.08)
        for name, expected in [("low", low), ("mid", mid), ("high", high)]:
            np.testing.assert_allclose(result["fft_bands"][name], expected, atol=1e-12)

    def test_known_spectral_period_and_dc(self):
        wavelength = .75 + np.arange(100) * .02
        spectrum = 3 + np.sin(2 * np.pi * np.arange(100) / 10)
        result = compute_spectral_fft(spectrum, wavelength)
        peak = np.argmax(result["fft_amplitude"][1:]) + 1
        self.assertEqual(peak, 10)
        self.assertAlmostEqual(result["fft_frequency_per_um"][peak], 5)
        self.assertAlmostEqual(result["fft_period_um"][peak], .2)
        self.assertIsNone(result["fft_period_um"][0])
        self.assertAlmostEqual(result["fft_amplitude"][0], 300)

    def test_rejects_irregular_missing_or_duplicate_wavelengths(self):
        for wavelength, spectrum in [([1, 2, 4, 5], [1]*4), ([1, 2, 2, 4], [1]*4),
                                     ([1, 2, 3, 4], [1, np.nan, 2, 3])]:
            with self.assertRaises(ValueError):
                compute_spectral_fft(spectrum, wavelength)

    def test_resamples_nonuniform_measurements_and_recovers_saturated_psf_ring(self):
        measurements = [
            {"wavelength_um": 0.758, "brightness": 18.4},
            {"wavelength_um": 1.124, "brightness": 24.1},
            {"wavelength_um": 1.682, "brightness": 31.7},
            {"wavelength_um": 2.415, "brightness": 21.9},
            {"wavelength_um": 3.812, "brightness": 12.6},
            {"wavelength_um": 4.871, "brightness": 8.2},
        ]
        fft = resample_spectral_grid(measurements, 32)
        self.assertIsNotNone(fft)
        self.assertEqual(len(fft["grid_wavelength_um"]), 32)
        self.assertEqual(len(fft["fft_amplitude"]), 17)
        reconstructed = (
            np.asarray(fft["fft_bands"]["low"])
            + np.asarray(fft["fft_bands"]["mid"])
            + np.asarray(fft["fft_bands"]["high"])
        )
        np.testing.assert_allclose(reconstructed, fft["grid_brightness"], atol=1e-12)

        plane = np.full((64, 64), 10.0, dtype=np.float32)
        plane[31:34, 31:34] = np.nan
        wave = np.full((64, 64), 2.5, dtype=np.float32)
        band = np.full((64, 64), 0.1, dtype=np.float32)
        wave_um, band_um, brightness, aperture_px = aperture_sample(plane, wave, band)
        self.assertIsNotNone(brightness)
        self.assertAlmostEqual(brightness, 10.0, places=5)
        self.assertAlmostEqual(wave_um, 2.5, places=5)
        self.assertAlmostEqual(band_um, 0.1, places=5)
        self.assertGreater(aperture_px, 0.0)

    def test_propagates_high_proper_motion_gaia_source_into_small_fov(self):
        ra_2016, dec_2016 = 269.452077, 4.693365
        ra_2026, dec_2026 = propagate_gaia_radec(ra_2016, dec_2016, -801.55, 10362.39, 2016.0, 2026.0)
        wcs = display_wcs(ra_2026, dec_2026, 150.0)
        px_2016, py_2016 = wcs.world_to_pixel_values(ra_2016, dec_2016)
        px_2026, py_2026 = wcs.world_to_pixel_values(ra_2026, dec_2026)
        self.assertGreater(float(py_2016), 64.0)
        self.assertAlmostEqual(float(px_2026), 31.5, delta=1.0)
        self.assertAlmostEqual(float(py_2026), 31.5, delta=1.0)


class ArchiveTests(unittest.TestCase):
    def test_rgb_sampling_loads_intermediate_real_exposures_and_preserves_endpoints(self):
        archive = Archive(self.cache)
        rows = [{"obs_id": f"obs{i}", "t_min": 61000+i, "obs_collection": "spherex_dr1",
                 "access_url": f"https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/obs{i}D{d}_spx_l2b-v2.fits"}
                for d in range(1, 7) for i in range(20)]
        rows.append(dict(rows[0], access_url=rows[0]["access_url"].replace("v2", "v1")))
        downloaded = []
        plane = encoded(np.ones((64, 64)))
        flags = encoded(np.zeros((64, 64)), "<u4")
        def cutout(row, *args):
            downloaded.append(row)
            detector = int(row["access_url"].split("D")[-1][0])
            return {"detector": detector, "mjd": row["t_min"], "collection": row["obs_collection"],
                    "frame": plane, "flags": flags, "wavelength_map": plane, "bandwidth_map": plane,
                    "wavelength_um": float(detector), "bandwidth_um": .1, "center_brightness": 1.0}
        with patch.object(archive, "search", return_value=(rows, ["spherex_dr1"])), \
             patch.object(archive, "cutout", side_effect=cutout), patch.object(archive, "catalogs", return_value=([], {})):
            preview = archive.build_sky(load_config(), 1, 2, 300, 10, "auto")
            self.assertEqual(len(preview["epochs"]), 12)
            downloaded.clear()
            rgb = archive.build_sky(load_config(), 1, 2, 300, 10, "auto", sampling="rgb")
        self.assertEqual(rgb["sampling"], "rgb")
        self.assertEqual(len(rgb["epochs"]), 42)
        self.assertEqual(len({row["access_url"] for row in downloaded}), 42)
        self.assertTrue(all("v2" in row["access_url"] for row in downloaded))
        for d in range(1, 7):
            dates = [ep["mjd"] for ep in rgb["epochs"] if ep["detectors"] == [d]]
            self.assertEqual(len(dates), 12 if d in (1, 3, 5) else 2)
            self.assertEqual((dates[0], dates[-1]), (61000, 61019))

    def test_empty_sia_finishes_without_catalog_downloads(self):
        archive = Archive(self.cache)
        progress = []
        with patch.object(archive, "search", return_value=([], ["spherex_dr1"])), \
             patch.object(archive, "catalogs", side_effect=AssertionError("unnecessary catalog request")):
            sky = archive.build_sky(load_config(), 1, 2, 300, 10, "auto", progress=lambda **p: progress.append(p))
        self.assertEqual(sky["data_status"], "empty")
        self.assertIn("No data found", sky["message"])
        self.assertEqual(progress[0]["phase"], "discovery")

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cache = DiskCache(self.directory.name)

    def test_live_discovery_includes_future_releases_excludes_cubes(self):
        xml = b'<VOTABLE><PARAM name="COLLECTION"><VALUES><OPTION value="spherex_dr2"/><OPTION value="spherex_dr2_deep"/><OPTION value="spherex_dr2_cube"/><OPTION value="wise_allwise"/></VALUES></PARAM></VOTABLE>'
        calls = []
        archive = Archive(self.cache, lambda url, params: calls.append(params) or xml)
        self.assertEqual(archive.collections(), ["spherex_dr2", "spherex_dr2_deep"])
        self.assertEqual(archive.collections(), ["spherex_dr2", "spherex_dr2_deep"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0], {"MAXREC": 0})

    def test_votable_error_is_not_empty_coverage(self):
        with self.assertRaisesRegex(ArchiveError, "service failed"):
            read_votable(b'<VOTABLE><RESOURCE><INFO name="QUERY_STATUS" value="ERROR">service failed</INFO></RESOURCE></VOTABLE>')

    def test_search_reuses_discovery_when_only_fov_changes(self):
        calls = []
        archive = Archive(self.cache, lambda url, params: calls.append(params) or b"unused")
        self.cache.put("collections", ["spherex_dr1"])
        with patch("archive.read_votable", return_value=([{"obs_id": "test"}], False)):
            small, _ = archive.search(1, 2, 150, 10, "auto")
            large, _ = archive.search(1, 2, 600, 10, "auto")
        self.assertEqual(small, large)
        self.assertEqual(len(calls), 1)

    def test_footprint_selection_handles_ra_wrap(self):
        row = {"s_region": "POLYGON ICRS 359 -1 1 -1 1 1 359 1"}
        self.assertTrue(covers_center(row, 0, 0))
        self.assertFalse(covers_center(row, 2, 0))

    def test_wavelength_lookup_does_not_apply_celestial_sip_twice(self):
        header = display_wcs(20, 30, 300).to_header()
        header.update(BUNIT="MJy/sr", DETECTOR=1, OBSID="sip-test", **{"MJD-OBS": 61000})
        header["CTYPE1"] = "RA---TAN-SIP"
        header["CTYPE2"] = "DEC--TAN-SIP"
        for key, value in {"A_ORDER": 2, "B_ORDER": 2, "A_2_0": .001, "B_0_2": .001,
                           "WCSAXESW": 2, "CTYPE1W": "LINEAR", "CTYPE2W": "LINEAR",
                           "CRPIX1W": 1, "CRPIX2W": 1, "CRVAL1W": 1, "CRVAL2W": .01,
                           "CDELT1W": .001, "CDELT2W": .00001, "CUNIT1W": "um", "CUNIT2W": "um"}.items():
            header[key] = value
        raw = io.BytesIO()
        fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(np.ones((64, 64)), header, name="IMAGE"),
                      fits.ImageHDU(np.zeros((64, 64), dtype=np.uint32), name="FLAGS")]).writeto(raw)
        archive = Archive(self.cache, lambda url, params: raw.getvalue())
        result = archive.cutout({"access_url": "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/sipD1_test.fits",
                                 "obs_collection": "spherex_dr1"}, 20, 30, 300)
        waves = np.frombuffer(base64.b64decode(result["wavelength_map"]), dtype="<f4").reshape(64, 64)
        world = display_wcs(20, 30, 300).pixel_to_world(10, 10)
        sx, sy = WCS(header).celestial.world_to_pixel(world)
        self.assertAlmostEqual(waves[10, 10], 1 + .001 * sx, places=6)

    def test_fov_wcs_scale_orientation_and_poles(self):
        for dec in [0, 66, 89.9]:
            for fov in [60, 150, 450, 1200, 1800]:
                wcs = display_wcs(359.99, dec, fov)
                center = wcs.pixel_to_world(31.5, 31.5)
                self.assertAlmostEqual(center.ra.deg, 359.99)
                self.assertAlmostEqual(center.dec.deg, dec)
                right = wcs.pixel_to_world(32.5, 31.5)
                self.assertAlmostEqual(center.separation(right).arcsec, fov / 64, places=4)

    def test_cutout_reprojects_orientation_preserves_flux_and_flags(self):
        wcs = display_wcs(20, 30, 300)
        wcs.wcs.cdelt *= -1
        header = wcs.to_header()
        header.update(BUNIT="MJy/sr", DETECTOR=1, OBSID="test", **{"MJD-OBS": 61000})
        for key, value in {"WCSAXESW": 2, "CTYPE1W": "LINEAR", "CTYPE2W": "LINEAR",
                           "CRPIX1W": 1, "CRPIX2W": 1, "CRVAL1W": 1, "CRVAL2W": .01,
                           "CDELT1W": .001, "CDELT2W": .00001, "CUNIT1W": "um", "CUNIT2W": "um"}.items():
            header[key] = value
        image = np.full((64, 64), 2, dtype=np.float32)
        image[20, 30] = 100
        flags = np.zeros_like(image, dtype=np.uint32)
        flags[10, 10] = 1 << 9
        buffer = io.BytesIO()
        fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(image, header, name="IMAGE"),
                      fits.ImageHDU(flags, name="FLAGS")]).writeto(buffer)
        requests = []
        archive = Archive(self.cache, lambda url, params: requests.append(params) or buffer.getvalue())
        row = {"access_url": "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/testD1_image.fits", "obs_collection": "spherex_dr1"}
        result = archive.cutout(row, 20, 30, 300)
        plane = np.frombuffer(base64.b64decode(result["frame"]), dtype="<f4").reshape(64, 64)
        self.assertEqual(plane[43, 33], 100)
        self.assertTrue(np.isnan(plane[53, 53]))
        self.assertEqual(result["center_brightness"], 2)
        self.assertEqual(result["detector"], 1)
        self.assertAlmostEqual(float(requests[0]["size"]), 600 * np.sqrt(2) / 3600)
        archive.cutout(row, 20, 30, 300)
        self.assertEqual(len(requests), 1)
        smaller = archive.cutout(row, 20, 30, 150)
        self.assertEqual(len(requests), 1)
        smaller_plane = np.frombuffer(base64.b64decode(smaller["frame"]), dtype="<f4").reshape(64, 64)
        self.assertFalse(np.array_equal(plane, smaller_plane, equal_nan=True))
        self.assertEqual(smaller_plane[43, 33], 2)


class EngineTests(unittest.TestCase):
    def test_rgb_refresh_finishing_during_preview_still_requests_the_completed_payload(self):
        finish = threading.Event()
        class FastArchive:
            def build_sky(self, config, *query, **kwargs):
                finish.wait(3)
                return dict(empty_sky(config, *query), sampling="rgb", data_status="empty")
        with tempfile.TemporaryDirectory() as directory:
            engine = SkyEngine(directory, FastArchive())
            try:
                def preview(candidates, config, query):
                    finish.set()
                    for future in list(engine.pending.values()):
                        future.result(timeout=3)
                    return dict(empty_sky(config, *query), preview=True, data_status="ready")
                with patch("server.cached_preview", side_effect=preview):
                    pending = engine.get_sky_cube(1, 2, sampling="rgb")
                self.assertTrue(pending["refreshing"])
                complete = engine.get_sky_cube(1, 2, sampling="rgb")
                self.assertFalse(complete["refreshing"])
                self.assertEqual(complete["sampling"], "rgb")
                self.assertEqual(complete["data_status"], "empty")
            finally:
                finish.set()
                engine.pool.shutdown()

    def test_rgb_loads_in_background_keeps_preview_and_has_a_separate_persistent_cache(self):
        finish = threading.Event()
        class SamplingArchive:
            calls = []
            def build_sky(self, config, *query, sampling="preview", **kwargs):
                self.calls.append(sampling)
                if sampling == "rgb":
                    finish.wait(3)
                count = 3 if sampling == "rgb" else 1
                return dict(empty_sky(config, *query), sampling=sampling, data_status="ready", grid_size=4,
                            epochs=[{"mjd": Time.now().mjd-i, "source": "spherex_dr1", "detectors": [1]} for i in range(count)],
                            frames_b64=encoded(np.ones((count, 6, 4, 4))), flags_b64=encoded(np.zeros((count, 4, 4)), "<u4"),
                            wavelength_maps_b64=encoded(np.ones((count, 4, 4))), bandwidth_maps_b64=encoded(np.ones((count, 4, 4))))
        with tempfile.TemporaryDirectory() as directory:
            archive = SamplingArchive()
            engine = SkyEngine(directory, archive)
            try:
                engine.get_sky_cube(1, 2, wait=True)
                start = time.perf_counter()
                pending = engine.get_sky_cube(1, 2, sampling="rgb")
                self.assertLess(time.perf_counter()-start, 1)
                self.assertTrue(pending["preview"])
                self.assertEqual(pending["requested_sampling"], "rgb")
                self.assertEqual(len(pending["epochs"]), 1)
                self.assertTrue(pending["refreshing"])
                engine.get_sky_cube(1, 2, sampling="rgb")
                finish.set()
                rgb = engine.get_sky_cube(1, 2, sampling="rgb", wait=True)
                self.assertEqual(len(rgb["epochs"]), 3)
                self.assertEqual(archive.calls, ["preview", "rgb"])
                restarted = SkyEngine(directory, archive)
                try:
                    self.assertEqual(len(restarted.get_sky_cube(1, 2)["epochs"]), 1)
                    self.assertEqual(len(restarted.get_sky_cube(1, 2, sampling="rgb")["epochs"]), 3)
                    self.assertEqual(archive.calls, ["preview", "rgb"])
                    with self.assertRaises(ValueError):
                        restarted.get_sky_cube(1, 2, sampling="unbounded")
                finally:
                    restarted.pool.shutdown()
            finally:
                finish.set()
                engine.pool.shutdown()

    def test_pending_request_reports_real_progress(self):
        reported, finish = threading.Event(), threading.Event()
        class ReportingArchive:
            def build_sky(self, config, *query, progress):
                progress(phase="cutouts", completed=1, total=3)
                reported.set()
                finish.wait(3)
                return dict(empty_sky(config, *query), data_status="empty")
        with tempfile.TemporaryDirectory() as directory:
            engine = SkyEngine(directory, ReportingArchive())
            try:
                engine.get_sky_cube(1, 2)
                self.assertTrue(reported.wait(2))
                result = engine.get_sky_cube(1, 2)
                self.assertEqual(result["progress"]["phase"], "cutouts")
                self.assertEqual(result["progress"]["completed"], 1)
                self.assertEqual(result["progress"]["total"], 3)
                self.assertTrue(result["refreshing"])
            finally:
                finish.set()
                engine.pool.shutdown()

    def test_preview_reprojects_and_masks_without_mutating_cached_observations(self):
        config = load_config()
        source = empty_sky(config, 1, 2, 300, 10, "auto")
        now = Time.now().mjd
        source.update(grid_size=4, data_status="ready", epochs=[
            {"mjd": now-2, "source": "spherex_dr1", "detectors": [1]},
            {"mjd": now-1, "source": "spherex_dr2", "detectors": [3]}],
            measurements=[{"mjd": now-1, "detector": 2, "brightness": 5, "wavelength_um": 2}],
            sources=[{"px": 3, "py": 1}])
        frames = np.full((2, 6, 4, 4), np.nan)
        frames[0, 0] = 2
        frames[1, 2] = 5
        source.update(frames_b64=encoded(frames), flags_b64=encoded(np.zeros((2,4,4)), "<u4"),
                      wavelength_maps_b64=encoded(np.ones((2,4,4))), bandwidth_maps_b64=encoded(np.ones((2,4,4))))
        original = json.dumps(source)
        result = cached_preview([(time.time(), source)], config, (1, 2, 600, 10, "spherex_dr2"))
        self.assertTrue(result["preview"])
        self.assertEqual(len(result["epochs"]), 1)
        self.assertEqual(result["epochs"][0]["index"], 0)
        self.assertEqual(result["measurements"], source["measurements"])
        self.assertEqual(result["pixel_scale_arcsec"], 150)
        plane = np.frombuffer(base64.b64decode(result["frames_b64"]), dtype="<f4").reshape(6,4,4)
        self.assertTrue(np.isnan(plane[2, 0]).all())
        self.assertEqual(plane[2, 1, 1], 5)
        flags = np.frombuffer(base64.b64decode(result["flags_b64"]), dtype="<u4").reshape(4,4)
        self.assertEqual(flags[0, 0], 1 << 9)
        self.assertEqual(result["sources"][0], {"px": 2.5, "py": 1.5})
        self.assertEqual(json.dumps(source), original)
        self.assertIsNone(cached_preview([(0, source)], config, (2, 2, 600, 10, "auto")))
        self.assertIsNone(cached_preview([(0, source)], config, (1, 2, 600, 10, "spherex_dr3")))

    def test_upstream_error_is_safe_for_display(self):
        class Unavailable:
            def build_sky(self, *args, **kwargs):
                raise RuntimeError("503 secret internal upstream URL")
        with tempfile.TemporaryDirectory() as directory:
            engine = SkyEngine(directory, Unavailable())
            try:
                with self.assertRaises(RuntimeError):
                    engine.get_sky_cube(1, 2, wait=True)
                result = engine.get_sky_cube(1, 2)
                self.assertEqual(result["data_status"], "error")
                self.assertNotIn("503", json.dumps(result))
                self.assertNotIn("secret", json.dumps(result))
            finally:
                engine.pool.shutdown()

    def test_validation_and_independent_fov_keys(self):
        self.assertEqual(normalize_query(361, 90, 450)[0], 1)
        for query in [(float("nan"), 0), (0, 91), (0, 0, 0), (0, 0, 300, float("inf"))]:
            with self.assertRaises(ValueError):
                normalize_query(*query)
        class FakeArchive:
            def build_sky(self, config, *query, **kwargs):
                return dict(empty_sky(config, *query), data_status="ready")
        with tempfile.TemporaryDirectory() as directory:
            engine = SkyEngine(directory, FakeArchive())
            try:
                for fov in [150, 450, 600]:
                    self.assertEqual(engine.get_sky_cube(1, 2, fov, wait=True)["fov"], fov)
                self.assertEqual(engine.get_sky_cube(1, 2, 450)["cache"], "HIT")
                restarted = SkyEngine(directory, FakeArchive())
                with patch.object(restarted.cache, "get", side_effect=AssertionError("memory hit must not read disk")):
                    self.assertEqual(restarted.get_sky_cube(1, 2, 150)["cache"], "HIT")
                restarted.pool.shutdown()
            finally:
                engine.pool.shutdown()

    def test_stale_cache_served_and_single_refresh_in_flight(self):
        gate = threading.Event()
        class FakeArchive:
            count = 0
            def build_sky(self, config, *query, **kwargs):
                self.count += 1
                gate.wait(2)
                return dict(empty_sky(config, *query), data_status="ready")
        with tempfile.TemporaryDirectory() as directory:
            fake = FakeArchive()
            engine = SkyEngine(directory, fake)
            try:
                self.assertEqual(engine.get_sky_cube(1, 2)["data_status"], "loading")
                self.assertEqual(engine.get_sky_cube(1, 2)["data_status"], "loading")
                gate.set()
                engine.get_sky_cube(1, 2, wait=True)
                self.assertEqual(fake.count, 1)
                engine.ttl = -1
                gate.clear()
                result = engine.get_sky_cube(1, 2)
                self.assertEqual(result["cache"], "STALE")
                self.assertEqual(result["data_status"], "ready")
                self.assertTrue(result["refreshing"])
            finally:
                gate.set()
                engine.pool.shutdown()


if __name__ == "__main__":
    unittest.main()
