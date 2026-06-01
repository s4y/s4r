sync:
	rsync style.css index.html S4r.js common.s4r default.s4r touch.html inputframe.html sw.js montaigne:/usr/share/nginx/viz/

.PHONY: test
test:
	node test/run.mjs
