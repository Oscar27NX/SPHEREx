# SPHEREx sky explorer

Run from this directory with Python 3.11 or newer:

```powershell
python -m pip install -r requirements.txt
python server.py --precache
python server.py
```

Open http://127.0.0.1:8080. The server starts warming the five presets automatically; `--precache` waits for them and writes `.cache/precache-report.json`. The SQLite database and compact FITS cutouts are stored in `.cache/archive.sqlite3`, survive restarts, and are excluded from Git. Copy this directory with the application when transferring a prepared demo. `SPHEREX_CACHE_DIR` changes the cache location; `SPHEREX_PORT` changes the local port.

The preset menu contains Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae, and R Draconis. Positions were resolved through CDS Sesame/SIMBAD on 2026-11-14. Barnard's epoch-2000 position is propagated to 2026.0 using its published proper motion, parallax, and radial velocity. WISE 0855 uses a 600-arcsecond field to include its displacement from the catalog position. Other presets use 300 arcseconds. The stored positions, provenance, and preset field sizes are in `releases.json`.

## Live data and cache behavior

The backend discovers current SPHEREx spectral-image collections from `https://irsa.ipac.caltech.edu/SIA?MAXREC=0`. It includes advertised wide and deep collections, rather than inventing release dates or hard-coding retired releases. The default `auto` selection searches all currently advertised spectral-image releases. The release selector can restrict that search. The refresh button updates release discovery.

SIA queries constrain position and observation time. The FOV is the full width of the square display in **arcseconds**; SIA discovers exposures containing its center, and IBE requests the requested field size. The requested time window ends at the current UTC time. The timeline brush selects among the actual returned observing dates; it does not synthesize earlier observations. `?ra=...&dec=...&fov=...&window=...` URLs work, and Share URL includes display settings.

For a responsive preview, the backend selects the earliest and latest available exposure per detector, preferring footprints containing the field center, after deduplicating reprocessed exposures. Exposures that only intersect the outer field are not included; the preview is not a complete mosaic. This is at most 12 cutouts, **not every exposure or a complete 102-channel spectrum**. The response records selection, collection names, observation dates, original access URLs, and any missing downloads. Small IBE cutouts are reprojected with their celestial WCS, including SIP distortion, onto a common north-up, east-left 64×64 grid. Nearest-neighbor sampling preserves the preview's measured surface-brightness values; this display is not a flux-conserving scientific mosaic.

SIA discovery and rendered previews expire after one hour. Expired previews remain visible while the backend refreshes them; new fields show a loading state. `SPHEREX_CACHE_TTL` changes the preview TTL in seconds. Failed refreshes preserve cached results and retry after a short backoff. Catalog queries use IRSA's Gator service for Gaia DR3 and AllWISE and are cached for a day. Successful versioned cutouts remain cached. Missing coverage, archive errors, and catalog errors are explicit; generated images or catalog records are never substituted.

Warm local cache latency is distinct from first-download latency. Uncached network requests cannot be guaranteed below 100 ms. IRSA also documents a delay between ingestion and SIA availability, so the application can only discover data already exposed by that service.

## Scientific display conventions

- SPHEREx `IMAGE` values are **MJy/sr**, not micrometers. Wavelengths and bandwidths come from the FITS spectral WCS and are in **µm**. The wavelength lookup uses detector pixels without reapplying the celestial SIP distortion.
- The spectrum panel shows actual center-pixel observations with their dates and wavelengths. Clicking the image samples that displayed pixel across the downloaded observations. This is a fixed sky position, not proper-motion tracking, source photometry, a simultaneous SED, or an inferred 102-band spectrum.
- A spectral FFT needs uniformly spaced wavelength samples. For spacing `Δλ` in µm and `N` samples, frequency is `k/(N Δλ)` cycles/µm; its reciprocal is a **spectral period** in µm. DC has no finite period. `3e8/k` is invalid for FFT bin indices. Even for electromagnetic frequency in Hz, `c/f` is in meters and needs a factor of `1e6` for µm.
- `compute_spectral_fft` rejects irregular, duplicate, or missing wavelengths. Live sparse cutouts therefore show an explicit unavailable-FFT state. No interpolation across missing channels is performed. The tested FFT contract returns amplitude `abs(FFT)`, not power, plus physical frequencies and periods.
- Available-array and Mean views average finite samples, with no zeros substituted for missing detectors. These are mixed-wavelength visualization composites, not claimed SNR-optimal coadds. RGB requires D1, D3, and D5 coverage. Spatial smoothing is a display-only local mean.
- Diff requires a single detector and at least two observations. It compares positive/negative means only where all selected center wavelengths differ by at most one quarter of the smaller local bandwidth. Other pixels remain blank. This is a conservative visualization check, not exact bandpass or PSF matching for scientific variability measurements.
- Gaia/WISE markers retain their catalog reference positions. Gaia motion vectors represent ten years of catalog proper motion; the markers are not automatically propagated to each image epoch. These overlays and raw archive pixel flags are optional and off initially to keep images visible.
- Aladin 3.8.2 loads on demand from a local, pinned distribution. Survey tiles still require an external archive. AllWISE uses IRSA's published HiPS mirror of `P/allWISE/color`; the CDS endpoints returned errors during verification. The core viewer uses local D3 and cached archive data, so external font or Aladin loading cannot block it.

## Verification

```powershell
python -m unittest discover -s tests -v
node --test tests/frontend.test.cjs
node --check app.js
```

Backend tests cover physical FFT periods, rejected inputs, future release discovery, explicit archive errors, RA-wrap footprints, WCS/FOV geometry, pixel/flag reprojection, spectral SIP handling, persistent caches, and concurrent refreshes. JavaScript tests cover request races, missing detectors, wavelength-safe differences, and share URLs.

`tests/browser.cjs` exercises the actual UI in headless Edge using a captured archive response as a fixture. It needs Playwright in `.cache/browser/node_modules`, a running server on port 8081, and `.cache/browser-fixture.json` containing an `/api/state` response. `BROWSER_PATH` can specify another Chromium executable. Its routed responses test UI behavior independently of archive availability; real cache contents are verified separately by `--precache`.

References: [IRSA SIA v2](https://irsa.ipac.caltech.edu/ibe/sia.html), [SPHEREx data access](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/), [SPHEREx products and units](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/), [IBE cutouts](https://irsa.ipac.caltech.edu/ibe/cutouts.html), [SciPy FFT frequencies](https://docs.scipy.org/doc/scipy/reference/generated/scipy.fft.rfftfreq.html), [CDS Sesame](https://vizier.cds.unistra.fr/vizier/doc/sesame.htx).

Third-party distributions: D3 7.9.0 (ISC, `vendor/LICENSE.d3`, https://github.com/d3/d3/tree/v7.9.0) and Aladin Lite 3.8.2 (GPL-3, `vendor/LICENSE.aladin`, source: https://github.com/cds-astro/aladin-lite and npm package `aladin-lite@3.8.2`). Their bundled files are unmodified; Aladin attribution remains visible.
