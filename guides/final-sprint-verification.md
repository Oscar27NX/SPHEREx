# Final sprint verification — 2026-11-15

This report updates the earlier six-point verification. All changes are within SPHEREx.

The subsequent [RGB correction report](rgb-verification.md) supersedes the RGB Blink behavior below: Blink now composes three nearest-date detector observations and displays their dates explicitly, instead of falling back to grayscale solely because the cursor's single exposure lacks all three detectors.

## RGB and playback

The bug was a forced transition from Blink to Mean whenever RGB was selected. Mean intentionally does not advance frames, and the mode persisted on later queries. RGB selection now preserves the current mode. A moving timeline cursor shows the current observation; the epoch dots remain hidden.

The downloaded observations usually contain one detector at a time. Blink therefore displays that dated observation in grayscale and explains which RGB channels are absent. **Mean (+)** explicitly combines D5/D3/D1 into red/green/blue across the selected observations. This is a non-simultaneous visualization, not three channels measured at the same instant.

Both the routed browser regression and the real-cache browser test verified continued RGB playback. The real test switched through Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae and R Draconis with RGB selected and confirmed that the active observation continued advancing for every target.

## Uncached fields

The UI now shows queued/search/download/catalog stages, elapsed seconds and completed/total image requests. Unknown work uses an indeterminate bar; reported counts come from completed backend futures. It remains possible to switch to another location. Failed requests use friendly messages, preserve an available view and retry. An empty SIA result returns “No data found” immediately without catalog downloads.

A real previously uncached query at RA **0.123456°**, Dec **80.123456°**, FOV **300 arcseconds**, window **0.5 years**, release **auto** was tested. Polls showed queued, then 0/12, 1/12, 3/12, 5/12, 6/12 and 8/12 images checked through 33 seconds. A subsequent probe returned **12 observed cutouts / 149 matching images**, with a cache hit. The exact first-completion time was not measured. Detailed responses are in `.cache/uncached-request-report.json`.

Separately, a controlled browser test drove Random through loading/progress to an empty result, checked that the progress bar disappeared, and confirmed the explanatory empty state. HTTP 503 handling is covered by the existing browser regression. Remote download latency is still dependent on IRSA; it is not claimed to meet the warm-cache response budget.

## Overlay meaning and alignment

- **Gaia circles:** approximate proper-motion positions at the displayed frame date, or at the midpoint of the contributing time span for composites. Lines connect reference positions to those estimates. Missing proper motion leaves a source at its reference position. The PM-only calculation omits parallax, radial velocity, perspective acceleration and uncertainty. Markers are visual catalog references, not confirmed source associations.
- **WISE diamonds:** catalog reference positions, explicitly labeled as not motion-corrected. The viewer does not extrapolate AllWISE apparent motion as if it were Gaia proper motion.
- **Quality squares:** archive flags for the current Blink frame, or their union over contributing composite frames. RGB unions use D1/D3/D5 when all three are available. A previous mismatch between composite flag outlines and single-frame hover information was fixed; both now use the same contributors and masks.
- **Spatial consistency:** marker coordinates use the same north-up/east-left tangent-plane geometry as the image WCS. Image and SVG share the zoom/pan transform. Off-image markers are clipped, and source selection considers visible enabled markers. Selecting a marker displays its catalog identity.
- **Fourier filters:** affect the brightness chart only. They do not move catalog markers or alter the image pixels.

The Gaia calculation was compared against Astropy `SkyCoord.apply_space_motion` and `display_wcs` using RA wraparound, latitude 66° and latitude 89.99°. Agreement was better than `1e-7` display pixels for these PM-only fixtures. Browser tests verified Gaia marker movement with observation dates and WISE consistency across FOV, zoom, Blink/Mean/Diff and brushing. A numerical contributor test verifies the flag union in RGB, individual-detector and Blink modes.

Reference conventions: [Gaia DR3 astrometric parameters](https://gea.esac.esa.int/archive/documentation/GDR3/Gaia_archive/chap_datamodel/sec_dm_main_source_catalogue/ssec_dm_gaia_source.html) and [AllWISE catalog columns](https://irsa.ipac.caltech.edu/data/WISE/docs/release/AllWISE/expsup/sec2_2.html).

## Showing the FFT feature

Click **FFT demo**, or open `http://127.0.0.1:8081/?demo=fft`. Select Raw, Low modes, Mid modes and High modes. Click FFT demo again to return to measured observations. The demonstration is explicitly labeled **synthetic signal, not sky measurements**, and it never replaces image data or enters the archive cache.

The demonstration has 48 samples, 0.08 µm apart, with a constant of 3 and cosine components at Fourier modes 3, 12 and 20. The expected one-sided amplitudes are 144 at DC and 24, 12 and 6 at those modes. Their periods are 1.28, 0.32 and 0.192 µm. Independent tests verify those amplitudes and each reconstructed low/mid/high component. The Python helper's previous overlapping mode masks were also corrected to agree with the disjoint browser filters.

A fresh audit of all five cached targets found no valid ordinary spectral FFT: Barnard's Star and R Draconis had no valid center samples, RW Aurigae had one, and Epsilon Indi B and WISE 0855 had irregular wavelengths. This does not prove that no suitable observations exist elsewhere. No verified real-coordinate FFT preset is claimed. Real spectra remain measured coverage displays unless their sampling passes validation.

## Results and reproduction

Passed: **16 Python tests**, **13 JavaScript unit tests**, both browser regression suites, JavaScript syntax checking, and the real-cache browser suite. No JavaScript page errors occurred. The final real-cache run at `2026-11-15T01:36:49.287Z` measured 20 FOV changes at **19.8–71.5 ms** from click through a painted frame, below the test's 100 ms budget. This is a local warm-cache measurement, not a guarantee for cold downloads or every overlay combination.

```powershell
python -m unittest discover -s tests -v
node --test tests/frontend.test.cjs
node --check app.js
node tests/browser.cjs
node tests/sprint-browser.cjs
node tests/live-browser.cjs
```

Browser tests use the running local server on port 8081 and Playwright under `.cache/browser/node_modules`. The first two browser suites use controlled responses based on `.cache/browser-fixture.json`; the live suite uses the real API and cache. Screenshots are saved to `.cache/fft-demo.png`, `.cache/latency-preview.png` and `.cache/sprint-empty-state.png`.
