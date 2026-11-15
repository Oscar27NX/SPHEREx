# Uju Gaja — SPHEREx Sky Explorer

(Uju Gaja = "let's go to space!", in korean).

A web explorer to visualize NASA SPHEREx sky timeline cutouts, built for the 2026 NASA Space Apps Challenge. Try the live static preset demo on [GitHub Pages](https://oscar27nx.github.io/SPHEREx/) or run locally to query any coordinate in the sky (decimal degrees or sexagesimal) to blink exposures, compare changes within the same detector band, inspect spectra and Fourier bands, and overlay Gaia DR3, AllWISE, and SPHEREx quality flags.

### Live GitHub Pages demo (one click away)

Open `https://oscar27nx.github.io/SPHEREx/`. All five NASA challenge presets (**Barnard's Star**, **Epsilon Indi B**, **WISE 0855**, **RW Aurigae**, and **R Draconis**) and all interactive controls (**Blink**, **Mean (+)**, **Diff (-)**, `D1`–`D6`, **RGB**, **Spatial smoothing**, **Spectral FFT**, **Gaia DR3**, **WISE**, **Flags**, **Aladin**, **Time Window Brush**, **Random**, and **Share URL**) work directly in the browser. Arbitrary new sky coordinates require running the local Python backend; we explain how to do so next.

##Local server set-up (full IRSA archive queries)

Run from the `SPHEREx/` directory with Python 3.11 or newer:

```powershell
python -m pip install -r requirements.txt
python server.py --precache
python server.py
```

To refresh the static GitHub Pages snapshots in `data/` from your local cache, run:

```powershell
python server.py --export-static
```

Open `http://127.0.0.1:8080`. The five challenge presets are available on startup (`releases.json`, resolved via CDS Sesame/SIMBAD on 2026-11-14). You can enter coordinates in decimal degrees or sexagesimal (for example `08h55m10.831s`, `-7d14m42.53s`), and click **Share URL** to copy an embeddable `?ra=...&dec=...&fov=...` link containing the displayed target's information.
Open `http://127.0.0.1:8080`. The five challenge presets are available on startup: **Barnard's Star**, **Epsilon Indi B**, **WISE 0855**, **RW Aurigae**, and **R Draconis**. You can enter coordinates in decimal degrees or sexagesimal (for example `08h55m10.831s`, `-7d14m42.53s`), and click **Share URL** to copy an embeddable `?ra=...&dec=...&fov=...` link containing the displayed target's information.

Alternatively, a demo containing only the data pertaining to the five challenge presets is readily available in the link: https://oscar27nx.github.io/SPHEREx/

## System overview

1. **Browser boot**: Opening the page calls `GET /api/state` to load release metadata, presets, and the initial sky view, then warms remaining presets via `POST /api/batch`. On static hosts (such as GitHub Pages), `app.js` falls back cleanly to `data/state.json` and pre-fetches `data/sky-*.json` snapshots in the background.
2. **Live archive & catalog query**: Locally, requesting a sky position calls `GET /api/sky`. The backend queries IRSA's SIA v2 endpoint to find matching SPHEREx exposures inside the requested release and time window (`0.5–15` years), while running concurrent cone searches on IRSA Gator for **Gaia DR3** and **AllWISE** catalog sources.
3. **Cutout retrieval & reprojection**: For selected exposures covering the field center, the server downloads compact FITS cutouts from IRSA IBE, masks fatal bitmask flags, reads local wavelengths and bandwidths from the FITS spectral WCS, and reprojects each frame onto a shared north-up, east-left `64×64` pixel grid encoded as Base64 typed arrays (`frames_1d_b64` stores only the active detector plane per epoch for compact static snapshots).
4. **Client-side interactive rendering**: `app.js` decodes the sky cube once in memory so switching modes (**Blink**, **Mean (+)**, **Diff (-)**), detectors (`D1`–`D6`, **Available arrays**, **Spatial smoothing**, **RGB**), **Spectral FFT** filters, FOV sizes, catalog overlays, and timeline brushes updates locally.

## Live data and caching

- **Static demo snapshots (`data/`)**: Pre-exported cubes cover all 5 presets across `150″`/`300″`/`600″`/`1200″` preview FOVs and `150″`/`300″`/`600″` `RGB` sets. Changing FOV or filtering by release (`SPHEREX DR1`, `SPHEREX QR3`) or time window on a preset derives the view directly on the client.
- **Live release discovery**: With `server.py`, the backend fetches available wide and deep SPHEREx collections from `https://irsa.ipac.caltech.edu/SIA?MAXREC=0`. The default `auto` option searches all advertised releases; the dropdown narrows to a single release and `↻` forces a live refresh.
- **Two-tier cache**: Sky cubes sit in a `128`-entry in-memory LRU cache backed by a persistent SQLite database (`.cache/archive.sqlite3`) along with raw FITS cutouts, SIA searches, and catalog queries (default 7-day TTL, configurable via `SPHEREX_CACHE_TTL`). Expired entries stay visible immediately while refreshing in the background.
- **Fast previews & resilient fallbacks**: Standard views first load a fast preview (earliest and latest exposure per detector) while **RGB** (`D1`/`D3`/`D5`) enriches up to 12 epochs in the background with live progress telemetry. Changing FOV (`150"`, `300"`, `600"`, `1200"`, or custom `60–1800"`) builds an instant preview from cached pixels while any larger request finishes.
- **Coordinate snapping & outage handling**: Rounded 5-decimal **Share URL** coordinates and 4-decimal **Go** input coordinates snap automatically to matching cached targets on both client and server. If IRSA SIA is temporarily unreachable, `Archive.search` falls back to previously cached observation footprints covering the requested center so IBE cutouts can still load, and **Random** falls back to available cached targets instead of leaving an error banner.

## Features

- **Units & WCS**: Pixel values are measured surface brightness in **MJy/sr** from SPHEREx `IMAGE` HDUs. Wavelengths and bandwidths are read from the FITS spectral WCS in **µm** across the six detector arrays (`D1`–`D6`, `0.75–5.0 µm`) at original detector pixels without reapplying celestial SIP distortion.
- **Viewing modes (`Blink`, `Mean (+)`, `Diff (-)`)**:
  - **Blink**: Steps through selected epochs in time order. **RGB** maps `D5` → Red, `D3` → Green, `D1` → Blue using the nearest-in-time exposure in each channel (skipping duplicate combinations and falling back to labeled grayscale if a channel is missing in the active brush).
  - **Mean (+)**: Averages finite pixels without null-filler detectors. **Spatial smoothing** applies a display-only `3×3` local mean; **Invert** flips the display stretch without modifying underlying data or masks.
  - **Diff (-) (Same-Band Subtraction)**: Subtracts earlier/`-` epochs from later/`+` epochs within the **same SPHEREx detector color band** (`D1`–`D6`). Single-band (`D1`–`D6`) and **RGB** views subtract within each band; **Available arrays** and **Spatial smoothing** compute per-band differences for every detector with `≥ 2` active epochs and average the valid difference maps together. You can click timeline epoch chips to cycle `+`, `-`, or `.` (skip), and drag the **Time Window Brush** to isolate specific date spans.
- **Brightness spectrum & spectral FFT**: Plots center-pixel (with PSF-aperture fallback), clicked-pixel, or explicitly labeled **field-mean** brightness (`MJy/sr`) vs. wavelength (`µm`). When observations have irregular LVF wavelengths (minimum 4 finite samples, drawing across active exposures when needed), they are linearly resampled onto a uniform 32-point grid so `|FFT|` bar amplitudes vs. spectral period (`µm`) and additive **Low / Mid / High** reconstructions work cleanly on real cutouts.
- **Overlays & quality flags**: **Gaia DR3** circles apply an approximate proper-motion shift (`pmra`, `pmdec`) to the displayed epoch (or contributor midpoint for composites) with trails from their reference epoch, omitting parallax, radial velocity, and uncertainties. **WISE** (`AllWISE`) diamonds mark static catalog positions. Clicking any marker shows its catalog ID and magnitude. **Flags** highlights active SPHEREx bitmask artifacts (`TRANSIENT`, `OVERFLOW`, `NONFUNC`, `GHOST`, `STREAK`, etc.) strictly from the exposures contributing to the current view (propagating neighbor flags under **Spatial smoothing**).
- **Aladin Lite survey panel**: Loads a local copy of Aladin Lite v3.8.2 on demand with **AllWISE Color** (served via IRSA's `P/allWISE/color` HiPS mirror), **2MASS Color**, and **DSS2 Optical**. Survey pan tracks the target coordinates while survey zoom stays independent of the SPHEREx science FOV.

## Used resources, datasets & licenses

| Resource | Role | Source / Endpoint | License / Terms |
| --- | --- | --- | --- |
| **NASA SPHEREx Mission Data** | Spectral-image discovery, FITS `IMAGE` cutouts, `FLAGS`, spectral `WCS-WAVE` | [IRSA SIA v2](https://irsa.ipac.caltech.edu/SIA) & [NASA/IPAC IRSA](https://irsa.ipac.caltech.edu/) (`/ibe/data/spherex/...`) | Public Domain / [NASA Open Data Policy](https://science.nasa.gov/open-science/open-data/) |
| **Gaia DR3 (`gaia_dr3_source`)** | Proper-motion star overlay & catalog identification | [IRSA Gator Cone Search](https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query) / [ESA Gaia DR3](https://www.cosmos.esa.int/web/gaia/dr3) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (ESA / DPAC) |
| **AllWISE (`allwise_p3as_psd`) & 2MASS** | Mid-/near-IR catalog overlay & Aladin HiPS survey imagery | [IRSA Gator](https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query) & [IRSA AllWISE HiPS](https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1) | Public Domain / [NASA/IPAC IRSA](https://irsa.ipac.caltech.edu/) |
| **CDS Sesame / SIMBAD** | Pre-cached preset target coordinate resolution (2026-11-14) | [CDS Sesame](https://cds.unistra.fr/cgi-bin/nph-sesame) / [SIMBAD](https://simbad.cds.unistra.fr/simbad/) | Open academic astronomy service (CDS) |
| **D3.js v7** | Interactive brightness spectrum, FFT bar chart, and time-window brush | [`vendor/d3.v7.min.js`](vendor/d3.v7.min.js) / [d3js.org](https://d3js.org/) | [ISC License](vendor/LICENSE.d3) |
| **Aladin Lite v3.8.2** | On-demand HiPS reference sky viewer | [`vendor/aladin-3.8.2.js`](vendor/aladin-3.8.2.js) / [CDS Aladin Lite](https://aladin.cds.unistra.fr/) | [GNU GPL v3](vendor/LICENSE.aladin) |
| **Astropy, NumPy, SciPy, Requests** | FITS/VOTable parsing, SIP WCS reprojection, FFT, HTTP retries (`requirements.txt`) | [PyPI](https://pypi.org/) (`astropy`, `numpy`, `scipy`, `requests`) | BSD-3-Clause (Astropy, NumPy, SciPy); Apache-2.0 (Requests) |
