# RGB correction and verification

Verified on 2026-11-15. This supersedes the earlier sprint's RGB-in-Blink grayscale behavior.

## Diagnosis

The previous renderer could produce color in Mean mode. However, Blink passed a single detector exposure to the RGB coverage check. Every cached exposure contained one detector, so every Blink frame took the whole-image grayscale fallback. This was intentional fallback code, but it made the RGB control ineffective in the default playback mode.

Before modification, all five targets had **zero colored pixels in RGB Blink**. RGB Mean had 2,594 colored pixels for Barnard's Star, 4,073 for Epsilon Indi B, 4,054 for WISE 0855, 4,005 for RW Aurigae, and 3,450 for R Draconis. The canvas test counted a pixel as colored when it was opaque and its largest and smallest channel values differed by more than 2 out of 255. These are display tests, not astrophysical color measurements.

## Correction and scientific meaning

RGB Blink now selects the closest available observation in time for **each** of D5, D3 and D1, using only the currently active observations. It maps those measured, spatially registered planes to red, green and blue. The frame cursor and playback keep advancing. Equal-distance ties choose the earlier exposure. The visible readout identifies all three dates, the temporal span, and the fact that the composite is non-simultaneous. Hovering over it shows releases and MJDs.

This is an explicit visualization choice. SPHEREx spectral images measure infrared surface brightness; wavelength varies with detector position, and spectra are acquired over multiple exposures. D1, D3 and D5 cover progressively longer infrared wavelength ranges. Assigning them to blue, green and red produces false color, not human-visible color. [Official SPHEREx product documentation](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/).

Channel stretches remain independent and consistent across the selected playback window. The composite does not claim simultaneous photometry, calibrated color ratios, PSF matching or a source-motion measurement. Dates can be far apart, and differences in dates, wavelengths and PSFs can create colored fringes. Missing channels are never synthesized or filled with a copied grayscale plane. A missing detector causes an identified whole-image grayscale fallback; incomplete pixels use identified grayscale, and pixels without any valid measurement remain transparent.

Flags and their tooltips now use the exact three contributing exposures. Gaia's approximate overlay date is their time-span midpoint, labeled as such; it is not misleadingly labeled as one exposure's date. Mean continues to average active data per channel. Diff still requires an individual detector.

## Objective results

The real-cache run at `2026-11-15T01:49:58.437Z` observed a complete playback cycle for each target without mocking API responses:

| Target | Frames checked | Colored pixels per frame | Distinct RGB images |
| --- | ---: | ---: | ---: |
| Barnard's Star | 12 | 2,630–3,790 | 2 |
| Epsilon Indi B | 12 | 3,977–4,031 | 2 |
| WISE 0855 | 12 | 3,988–4,013 | 2 |
| RW Aurigae | 12 | 3,599–4,023 | 2 |
| R Draconis | 12 | 1,478–3,799 | 2 |

All **60 frames contained color**, and every target changed RGB image during its cycle. Two distinct images are expected for these cached samples: only early and late exposures per detector were downloaded, so nearest-channel choices can repeat across adjacent cursor dates. No JavaScript page errors occurred.

Controlled tests separately verify exact green and magenta output from independent D5/D3/D1 input patterns, a time-dependent switch of those colors, unchanged measured data, time-window restrictions, deterministic nearest-date selection, missing-detector grayscale, and flags from the actual RGB contributors. These tests establish channel identity and selection correctness, not merely the existence of non-gray pixels.

Passed: **15 JavaScript unit tests**, the existing browser regression, the sprint browser regression, the real-cache RGB browser test, and the real-cache performance test. JavaScript syntax checking passed. The final performance run measured 20 cached FOV changes at **20.8–72.7 ms**, still under the 100 ms local test budget.

```powershell
node --check app.js
node --test tests/frontend.test.cjs
node tests/browser.cjs
node tests/sprint-browser.cjs
node tests/rgb-browser.cjs
node tests/live-browser.cjs
```

Browser prerequisites are documented in the README. Detailed artifacts: `.cache/rgb-before.json`, `.cache/rgb-after.json`, `.cache/rgb-after.png`, and `.cache/latency-report.json`. The recorded color counts depend on the currently cached observations and can change after an archive refresh.
