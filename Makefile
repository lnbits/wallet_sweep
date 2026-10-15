LNBITS_ROOT ?= ../lnbits

.PHONY: check build check-host
check:
	cd dev && npm run check

build:
	cd dev && npm run build

check-host:
	PYTHONPATH="$(LNBITS_ROOT)" "$(LNBITS_ROOT)/.venv/bin/python" dev/test/host_integration.py

.PHONY: package
package:
	python3 dev/scripts/package.py

.PHONY: check-release
check-release:
	python3 dev/scripts/validate_release.py
