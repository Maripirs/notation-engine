# Examples

`vanilla/index.html` is a single self-contained page that loads
notation-engine from the jsDelivr CDN, renders a short built-in tune, and
lets you open your own `.musicxml` file and play it. There is nothing to
install or build: open the file in a browser (everything it loads comes
from the CDN, so opening it straight from disk works), or serve the folder
with any static server, such as `python3 -m http.server -d examples/vanilla`.
