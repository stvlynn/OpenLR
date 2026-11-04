# Segmentation fixtures

These real public-domain photographs are retained once as original test inputs.

- `astronaut.png`: NASA Great Images photograph of Eileen Collins, from scikit-image v0.25.2. [Image](https://github.com/scikit-image/scikit-image/blob/v0.25.2/skimage/data/astronaut.png), [source/public-domain statement](https://github.com/scikit-image/scikit-image/blob/v0.25.2/skimage/data/_fetchers.py). SHA-256 `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`.
- `rocket.jpg`: SpaceX Falcon 9/DSCOVR photo, released into the public domain, from scikit-image v0.25.2. [Image](https://github.com/scikit-image/scikit-image/blob/v0.25.2/skimage/data/rocket.jpg), [source/rights statement](https://github.com/scikit-image/scikit-image/blob/v0.25.2/skimage/data/_fetchers.py). SHA-256 `c2dd0de7c538df8d111e479619b129464d0269d0ae5fd18ca91d33a7fdfea95c`.

Manual interior rectangles are weak region probes, not dense ground-truth masks. Derived comparison figures come from `scripts/benchmark-ai.mjs`; original fixture bytes remain unchanged.
