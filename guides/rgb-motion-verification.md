# RGB playback cadence verification

Verified on 2026-11-15 using headless Microsoft Edge, the local Python server, and real cached observations for all five presets. This follows the earlier [RGB color correction](rgb-verification.md).

## Confirmed problem

RGB Blink already selected separate nearest-date observations for D5 (red), D3 (green), and D1 (blue). It did not interpolate or average successive animation frames. However, its timer still visited every individual exposure date. Several adjacent dates selected exactly the same three RGB input planes, so the cursor moved while the image repeated.

At the 120 ms setting, each tested target had twelve exposure anchors but only two different RGB combinations. Before this correction, twenty of twenty-four RGB transitions repeated the identical canvas image. New content appeared about every 720 ms, despite the selected 120 ms interval. This was a playback cadence problem, not evidence of temporal smoothing.

## Change

RGB Blink now advances to the next anchor with a different tuple of D5/D3/D1 exposure indices. It retains the original measured image planes, nearest-date selection, channel stretches, masks, dates, and overlay contributors. No synthetic intermediate positions, interpolated frames, or amplified source displacements are introduced. Intermediate combinations are retained when staggered detector dates produce them.

The visible readout shows `RGB 1/2`, for example. If the selected observations produce only one combination, the image holds still and explains that the time brush must be widened to compare. Playback resumes when the selection offers more combinations. Missing-detector grayscale fallback continues through the available exposures. Available arrays, individual detectors, Mean, and Diff retain their existing behavior. The tooltip states that playback skips unchanged channel selections and that date intervals are not uniform; the animation is not a constant-rate physical-time simulation.

## Real-image measurements

The same browser measurement ran before (`2026-11-15T09:17:08.335Z`) and after (`2026-11-15T09:19:50.570Z`) the fix. Each case observed 24 transitions at the 120 ms setting. No API responses were mocked. Canvas image equality, rather than cursor movement alone, determined whether an image changed.

| Target | RGB changed transitions before | RGB changed transitions after | Mean interval before | Mean interval after |
| --- | ---: | ---: | ---: | ---: |
| Barnard's Star | 4/24 | 24/24 | 719.9 ms | 120.0 ms |
| Epsilon Indi B | 4/24 | 24/24 | 720.1 ms | 120.0 ms |
| WISE 0855 | 4/24 | 24/24 | 719.8 ms | 120.0 ms |
| RW Aurigae | 4/24 | 24/24 | 719.9 ms | 120.0 ms |
| R Draconis | 4/24 | 24/24 | 720.3 ms | 120.0 ms |

Available arrays changed on all 24 transitions for every target before and after. RGB still has exactly two distinct images for each of these cached samples; the correction removes redundant holds, without creating more observations. The separate real-cache color test confirmed color in both combinations for all five targets, with the same per-target colored-pixel ranges reported in the earlier color verification. No JavaScript page errors occurred.

The timing is a local foreground-browser measurement, not a guaranteed interval under background-tab throttling or an overloaded device. An archive refresh can change the available combinations. The regression's no-repeated-images assertion assumes these presets still contain differing observations; genuinely identical observations are valid data.

## Scientific interpretation

Available arrays steps between detector observations at different dates and wavelengths. RGB combines three selected detector observations, which may be non-simultaneous. Consequently, their visual change amplitudes need not agree: changing wavelength coverage, brightness, PSF, or missing-pixel coverage can produce flicker without source displacement. SPHEREx's documented detector-dependent PSFs and position-dependent wavelengths support this distinction. [Official SPHEREx data products](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/).

For these cached previews, neither a changing canvas nor greater apparent motion establishes an astrophysical motion measurement. The benchmark's mean absolute pixel difference is display variation only. A controlled test separately places a source at known positions three pixels apart in two sets of channel planes. Playback preserves both exact positions and the full displacement, with no intermediate source positions or blending. Scientific motion comparisons additionally require compatible wavelength coverage, registration, PSFs, and adequate spatial/time resolution; selecting one detector reduces band switching but alone does not establish these conditions.

## Regression coverage

All 20 JavaScript unit tests passed. The new coverage checks redundant-selection skipping, staggered detector dates, wraparound, empty input, a single-combination window and its explanation, missing-detector fallback, pause, Mean-mode inactivity, resuming after widening the selection, and the known three-pixel shift. Existing tests verify exact RGB channel identity, nearest-date ties, unchanged input values, contributor quality flags, and wavelength-safe differences.

The general UI, sprint UI, real-cache RGB, real-cache cadence, and real-cache performance browser tests passed. These cover brush interaction, RGB playback across later queries, catalog alignment, FOV and zoom, inversion, missing channels/pixels, release-error recovery, and spectral controls. The performance test measured 20 cached FOV changes at **31.1–47.9 ms** on this run. Backend code was not changed for this correction.

```powershell
node --check app.js
node --test tests/frontend.test.cjs
node tests/browser.cjs
node tests/sprint-browser.cjs
node tests/rgb-browser.cjs
node tests/rgb-motion-browser.cjs
node tests/live-browser.cjs
```

Browser prerequisites are in the README. Local measurement artifacts are `.cache/rgb-motion-before.json`, `.cache/rgb-motion-after.json`, `.cache/rgb-after.json`, and `.cache/latency-report.json`. The `--baseline` option on the cadence test records behavior without enforcing the no-repeat assertion; reproducing the old behavior requires the pre-fix code. This verification establishes the listed cases, not correctness for every possible future archive response.
