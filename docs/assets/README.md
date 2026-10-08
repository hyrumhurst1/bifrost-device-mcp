# Bifrost brand assets

An original geometric bridge with a stepped arch, warm inner pathway, and separated endpoints. Warm burgundy, ember orange, and cream; the pixel motif is confined to the symbol and a faint background grid.

| Asset | Size | Use |
|---|---|---|
| `bifrost-banner.svg` / `.png` | 1200 × 400 | Repository README header |
| `bifrost-social.svg` / `.png` | 1200 × 630 | Social preview and launch image |
| `bifrost-wordmark.svg` / `.png` | 460 × 140 | Transparent wordmark for dark backgrounds |
| `bifrost-icon.svg` / `.png` | 256 × 256 | Repository/project icon |

SVGs are editable, repo-native source assets with accessible titles and descriptions. PNGs are rendered previews for platforms that do not accept SVG. Typography uses the freely available DejaVu Sans family, with a generic sans-serif fallback.

## Palette

- Burgundy: `#411521`
- Deep background: `#211017`
- Ember: `#ff936a`
- Warm cream: `#fff0df`
- Secondary text: `#e5c5be`

The repository banner and social card deliberately say **preview**. Creator attribution is **Created by Hyrum Hurst**; project attribution is **A Phoenix Labs project**.

## Re-render

With Inkscape installed:

```sh
for name in banner social wordmark icon; do
  inkscape "docs/assets/bifrost-$name.svg" \
    --export-type=png \
    --export-filename="docs/assets/bifrost-$name.png"
done
```
