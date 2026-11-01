# Tracefield

A browser-based lab for hand-drawn plot-maps. Scan paper questionnaires, digitize each drawn line into a data series, then label, overlay, average, sculpt and listen to them on an infinite pinboard.

## Run

There is no build step. Open `index.html` in a browser, or serve the folder:

```
npx serve .
```

Work auto-saves to the browser's IndexedDB. Use **Project → Export** for a portable `.json` backup.

## Layout

| Path | Purpose |
| --- | --- |
| `index.html`, `style.css` | Page shell and styles |
| `script.js` | Boot, import, export, demo data |
| `js/core.js` | Helpers, state, persistence, undo |
| `js/board.js` | Pinboard: pan, zoom, drag, links, pen |
| `js/cards.js` | Card rendering and in-card interaction |
| `js/plot.js` | Line maths, SVG plots, sonification, playhead |
| `js/panels.js` | Inspector, library, dialogs |
| `js/digitizer.js`, `js/vision.js` | Scan calibration and ink detection |
