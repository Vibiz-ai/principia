---
name: fal-image
description: Generate or edit images with fal.ai (FLUX) using the FAL_KEY environment variable. Use when asked to create an image, illustration, mockup or visual asset.
---

# fal.ai images

The key is in `$FAL_KEY` (Hive injects it from Keys). Never print it.

```sh
curl -s https://fal.run/fal-ai/flux/dev \
  -H "Authorization: Key $FAL_KEY" -H 'Content-Type: application/json' \
  -d '{"prompt":"...","image_size":"landscape_16_9","num_images":1}' | jq -r '.images[0].url'
```

Then download the URL to `$ARTIFACTS_DIR/<name>.png` (or the current folder when ARTIFACTS_DIR is unset) and report the path.

Image sizes: `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`.
Faster drafts: `fal-ai/flux/schnell`. Write concrete prompts: subject, composition, lighting, style, lens.

If FAL_KEY is missing, tell the user to add it in Hive › Keys.
