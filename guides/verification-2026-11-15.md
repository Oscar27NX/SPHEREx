# Verification of the six requested fixes

Verified locally on 2026-11-15 with Python 3.14 and headless Microsoft Edge at 1440 × 1000. The live-browser run used the real SQLite cache and local API, without routing or mocking API responses. Failure cases and mathematically controlled spectra were tested separately with fixtures.

| Request | Implemented behavior | Experimental evidence |
| --- | --- | --- |
| FOV latency | Browser-held observations produce an immediate, labeled preview. Native FITS downloads, SIA searches, decoded arrays, and stretch limits are reused; refinement runs in the background. | All 20 FOV changes across five targets updated synchronously and painted in 15.1–47.3 ms in the final run. The test asserts a 100 ms maximum. |
| Cache and inversion | SQLite survives restarts; memory serves warm responses; previews preserve measured values and mask uncovered sky. Exact projections have independent FOV keys. Invert changes display brightness only. | Backend restart, single-refresh, FOV-key, reprojection, and discovery-reuse tests pass. Browser checks confirm normal/inverted pixel channels sum to 255 within rounding, with identical alpha masks. |
| RGB missing data | D5/D3/D1 map to red/green/blue in Mean mode. A missing required detector yields labeled grayscale. Incomplete individual RGB pixels also use grayscale; absent pixels stay transparent. | Browser cases test both a wholly missing D5 and a missing D5 pixel while D5 exists elsewhere. Usable pixels remain visible and fallback pixels have equal R/G/B channels. |
| Brightness and frequency panels | Center/selected-pixel measurements are displayed when valid. An explicitly labeled field mean replaces an unavailable pixel. Sparse spectra show detector coverage and an explanation. Low/mid/high filters require valid uniform sampling. | All five real targets display images and measured brightness points. Controlled 12-sample spectra verify DC amplitude, sinusoid amplitude/period, all three components, and reconstruction. Browser tests activate all three filters on the controlled spectrum and verify disabled controls for unsupported observations. |
| Releases and missing observations | Cached observations are filtered by release and date. Failures retain usable observations, show friendly text, and schedule retry. Empty fields and invalid image combinations have visible explanations. | Browser tests inject HTTP 503, select cached and uncached releases, verify retained images and no raw 503 text, restore the service, and confirm animation resumes. Backend tests check safe error messages and release-isolated previews. |
| Zoom, brush, and code checks | Aladin zoom is stored separately from science FOV. Hidden epoch dots do not affect brushing. Same-epoch refreshes retain time selection and playback position. | An Aladin event test checks scalar/array handling without a science-FOV change or zoom reset. Browser dragging changes selected epochs while dots remain invisible. Request-race, URL, missing-pixel, and wavelength-compatible difference tests pass; JavaScript syntax and whitespace checks pass. |

## Real cached targets

Final run: `2026-11-15T01:08:43.609Z`. Each target was tested at 150, 600, 1200, and 300 arcseconds.

| Target | Brightness displayed on target selection | Valid displayed image pixels | FOV click-to-paint range |
| --- | --- | ---: | ---: |
| Barnard's Star | 12 field-mean observations; center unavailable | 4008 | 16.2–47.3 ms |
| Epsilon Indi B | 11 center-pixel observations | 4072 | 18.4–42.4 ms |
| WISE 0855 | 12 center-pixel observations | 4071 | 39.1–47.1 ms |
| RW Aurigae | 1 center-pixel observation | 4077 | 15.1–39.7 ms |
| R Draconis | 12 field-mean observations; center unavailable | 3836 | 15.9–27.1 ms |

Timing runs from the DOM click through two animation-frame callbacks, allowing a paint between them. No JavaScript page errors occurred. Detailed measurements and a screenshot are saved in `.cache/latency-report.json` and `.cache/latency-preview.png`.

## Reproduction

From `SPHEREx`, run:

```powershell
python -m unittest discover -s tests -v
node --test tests/frontend.test.cjs
node --check app.js
node tests/browser.cjs
node tests/live-browser.cjs
```

Results: 13 backend tests, 10 JavaScript unit tests, browser regression checks, and the 20-change live latency check passed. Browser tests require the running local server on port 8081 and Playwright under `.cache/browser/node_modules`. The regression suite uses `.cache/browser-fixture.json`; the live suite requires the five prepared targets in the real cache.

## Limits of these results

The latency result applies to warm-cache previews on this machine, not first downloads or every possible overlay configuration. Expanding a field beyond cached coverage shows blank margins until retrieval succeeds. New coordinates with no compatible cached data still require IRSA access. Service availability and remote survey tiles cannot be guaranteed by local tests; the Aladin zoom regression uses a controlled viewer interface, not a tile-download availability test.

The observed cutouts remain sparse measurements from different wavelengths and dates, not complete 102-channel spectra. A scientifically valid ordinary FFT is unavailable for the current irregular samples. The application explains that constraint and shows measured coverage; it does not invent missing channels, replace masked center pixels with claimed center photometry, or enable unsupported filters.
