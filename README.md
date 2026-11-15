# SPHEREx sky explorer

## Set-up

Run from this directory with Python 3.11 or newer:

```powershell
python -m pip install -r requirements.txt
python server.py --precache
python server.py
```

Open http://127.0.0.1:8080. The server starts warming the five presets automatically.
The preset menu contains Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae, and R Draconis. Positions were resolved through CDS Sesame/SIMBAD on 2026-11-14. WISE 0855 uses a 600-arcsecond field to include its displacement from the catalog position. Other presets use 300 arcseconds. The stored positions, provenance, and preset field sizes are in `releases.json`.

## Live data and cache behavior

The backend discovers current SPHEREx spectral-image collections from `https://irsa.ipac.caltech.edu/SIA?MAXREC=0`. It includes the advertised wide and deep collections. The default `auto` selection searches all currently advertised spectral-image releases. The release selector can restrict that search. The refresh button manually updates release discovery.

SIA queries constrain position and observation time. The FOV is the full width of the square display in **arcseconds**. SIA discovers exposures containing its center. Native IBE cutouts use shared 600/1200/2400-arcsecond size buckets (with diagonal padding). The timeline brush selects among actual returned observing dates; the epoch dots are hidden without disabling the brush. `?ra=...&dec=...&fov=...&window=...` URLs work, and Share URL includes display settings.

For a responsive preview, the backend selects the earliest and latest available exposure per detector band, preferring observations containing the field center, after deduplicating reprocessed exposures. Exposures that only intersect the outer field are not included. The response records selection, collection names, observation dates, original access URLs, and any missing downloads. Small IBE cutouts are reprojected with their celestial WCS, including SIP distortion, onto a common north-up, east-left 64×64 grid.

SIA discovery and rendered previews expire after one hour. Expired previews remain visible while the backend refreshes them; new fields show a loading state. 

Uncached requests show retrieval stages, elapsed time and actual completed/total image requests. Discovery and queue stages use an indeterminate progress bar. When SIA returns no images, the response immediately says “No data found” without waiting for catalog downloads.

## Scientific display conventions and features

- SPHEREx `IMAGE` values are **MJy/sr**, not micrometers. Wavelengths and bandwidths come from the FITS spectral WCS and are in **µm**. The wavelength lookup uses detector pixels without reapplying the celestial SIP distortion.
- The spectrum panel shows actual center-pixel observations with their dates and wavelengths. Clicking the image samples that displayed pixel across the downloaded observations. If that pixel has no valid observations, the panel explicitly switches to a **field mean** of valid pixels, with the corresponding mean wavelengths. This fallback is not center-pixel photometry and is not used for FFT filtering. If the entire field is unavailable, explanatory messages replace empty image and chart panels. These previews are not proper-motion tracking, source photometry, a simultaneous SED, or an inferred 102-band spectrum.
- A spectral FFT needs uniformly spaced wavelength samples. For spacing `Δλ` in µm and `N` samples, frequency is `k/(N Δλ)` cycles/µm; its reciprocal is a **spectral period** in µm. 
- `compute_spectral_fft` rejects irregular, duplicate, or missing wavelengths. The browser checks the same sampling requirement and requires at least four samples. Amplitude is `abs(FFT)`, not power.
- Available-array and Mean views average finite samples, with no zeros substituted for missing detectors. RGB combines D5/D3/D1 into red/green/blue in Mean mode. A missing required detector triggers a labeled grayscale view of available data; individual pixels with incomplete RGB coverage also use labeled grayscale. Fully missing pixels remain transparent. Invert complements the display stretch and leaves measured values and masks unchanged. Spatial smoothing is a display-only local mean.
- Diff requires a single detector and at least two observations. It compares positive/negative means only where all selected center wavelengths differ by at most one quarter of the smaller local bandwidth. Other pixels remain blank. This is a conservative visualization check, not exact bandpass or PSF matching for scientific variability measurements.
- Gaia circles are projected into the image WCS after an approximate proper-motion propagation to the frame's date, or to the midpoint of the contributing time span for a composite. Lines connect the reference and estimated positions. Sources without proper motion remain at their reference positions. This PM-only estimate omits parallax, radial velocity, perspective acceleration and positional uncertainty; it is a visual aid, not a confirmed source association. AllWISE diamonds retain their reference positions. Overlay labels explain these differences, and clicking a visible marker identifies its catalog entry.
- Quality-flag outlines and hover readouts use the same contributing frames: the current frame for single-channel Blink, the three chosen exposures for RGB Blink, or the selected contributors for Mean. RGB Gaia markers use the midpoint of the contributing observation dates and are labeled accordingly. Image and overlay share the same zoom transform. Fourier controls filter the brightness spectrum, not the spatial image or catalog positions.
- Aladin 3.8.2 loads on demand from a local, pinned distribution. Survey tiles still require an external archive. AllWISE uses IRSA's published HiPS mirror of `P/allWISE/color`; the CDS endpoints returned errors during verification. The core viewer uses local D3 and cached archive data, so external font or Aladin loading cannot block it.
- Aladin retains the user's survey zoom across coordinate/FOV updates. Survey zoom is separate from the SPHEREx science FOV and does not trigger an image query.

# Used resources
