# Tracefield

A browser-based lab for hand-drawn plot-maps. Scan paper questionnaires, digitize each drawn line into a data series, then label, overlay, average, sculpt and listen to them on an infinite pinboard, or place them on a map alongside the soundscapes they describe.

The map side was built for one kind of study: participants map how they experienced the passage of time, and those graphs are used to re-design recorded soundscapes. The atlas lets people listen to those experiences where they happened.

## Run

There is no build step. Open `index.html` in a browser, or serve the folder:

```
npx serve .
```

Work auto-saves to the browser's IndexedDB. Use **Project → Export** for a portable `.json` backup. The map background needs an internet connection; the pinboard does not.

To explore without your own data, choose **Sound map demo** on the welcome screen. Its sounds and quotes are synthetic.

## The map

Use the background button at the top left to swap the pinboard for a map.

| Background | Needs |
| --- | --- |
| Streets, Night, Satellite, Satellite + labels, Earth globe | Nothing |
| Google Maps, Satellite, Hybrid, Terrain | Google API key with the Maps JavaScript API |
| Google Earth 3D | Google API key with the Map Tiles API |

**Building the map**

- **Points:** press `A` and click, or drop a WAV, MP3, M4A, OGG or FLAC file on the map. The participant ID is read from the file name.
- **Regions:** press `R`, click the corners, then press Enter.
- **Graphs:** drag a map or lens from the library onto the map to pin it. Drop it on a point to link it to that point as well.
- **Links:** press `C` and drag between any two points or graphs. Choose an arrow, line, dashed line or flow.

**Sound on each point**

Every point has two slots: **As recorded** and **As felt**. If you have re-designed the soundscape yourself, upload it to the second slot. The dock crossfades between the two and keeps them in step, even when they differ in length. At either end of the slider the file you hear plays unchanged. Partway along, the quieter file is stretched to stay in step with the louder one.

An uploaded re-design plays exactly as uploaded, unless you tick **Apply to the "as felt" file** in the felt-time drive. Without one, the **felt-time drive** reshapes the recording live from a linked graph's lines:

| Target | High on the line | Low on the line |
| --- | --- | --- |
| Tempo | faster | slower |
| Emphasis | louder | quieter |
| Brightness | open | muffled |
| Space | more reverb | drier |

Each target has a depth control and can be inverted to match how your axes are labelled.

**Listening**

- **Listening dock:** shows the waveform with the driving line on top, and a dial comparing clock time with felt time. Hold `Space` to flip between the recording and how it felt.
- **Soundwalk (`W`):** move across the map and each place fades in with distance and pans in stereo. Sounding places send out ripples at their felt tempo, so slow time looks slow.
- **Journey (`J`):** flies to each stop along your arrows, plays it, and shows the quote and graph.
- **Exhibit (`X`):** hides the editing tools and shows an intro screen for visitors.

**Sharing an exhibit**

Host the folder and an exported project together, then link to:

```
index.html?project=study.json&exhibit
```

This opens the project read-only for visitors and doesn't touch anything saved in their browser.

### Setting up Google

Google Earth has no embeddable API. **Google Earth 3D** uses Google's Photorealistic 3D Tiles, the same kind of imagery, rendered with [Cesium](https://cesium.com/platform/cesiumjs/).

1. In the [Google Cloud console](https://console.cloud.google.com/google/maps-apis), create a project with billing enabled.
2. Enable the Maps JavaScript API, the Map Tiles API and the Geocoding API.
3. Create a key and restrict it to your site's address. A key restricted this way won't work on a page opened straight from a file, so serve the folder.
4. In the app, choose **Add Google API key** from the background menu.

The key is stored in that browser only and is never written to project exports. Each visitor's browser needs it too, so for a public exhibit either use the free backgrounds or plan how the key gets configured. Google bills for usage.

### Data and privacy

Recordings stay in the browser unless you export them. Viewing a map requests tiles for that area from the map provider, and place search sends what you type to OpenStreetMap's Nominatim, or to Google on a Google background.

An exported project contains the recordings, participant labels, quotes and exact coordinates. Check it against your consent terms before sharing it. `.gitignore` keeps audio files and exported projects out of this repository by default.

### Limits

- Project files with more than about 360 MB of audio may be too large to reopen, because they load as one JSON document. The app warns before exporting one.
- The free backgrounds use Esri's public tile services and Mapzen terrain tiles. Check Esri's terms before a commercial or high-traffic deployment.

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
| `js/geo.js` | Map engines behind one camera and projection interface |
| `js/soundscape.js` | Audio library, felt-time drive, crossfade, demo sounds |
| `js/atlas.js` | Points, regions, pins, links, dock, soundwalk, journey, exhibit |
