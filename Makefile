# Makefile for the Claude Code model-router single-binary build + service.
#
# The router is one zero-dependency .mjs; `bun --compile` bakes it together with
# the bun runtime into a self-contained executable (no Node needed on target).
#
#   make            # build      -> dist/claude-router
#   make install    # build + install binary, config, and the systemd --user service
#   make dist       # smaller, shippable compressed artifact -> dist/claude-router.xz
#   make uninstall  # stop/disable service, remove binary + unit (keeps config)
#   make clean      # remove dist/
#   make test       # run the test suite
#   make help       # list targets
#
# NOTE — why there is no `strip`:
#   `strip` is intentionally NOT used. bun --compile appends the JS bundle plus a
#   locator trailer to the end of the executable; strip relocates that trailer and
#   the binary stops recognizing its own payload (it falls back to the plain `bun`
#   CLI and refuses to run). Strip also does not shrink it — the ~98 MB is the
#   embedded runtime, not the ELF symbol table (verified: 98 MB before and after).
#   To get a smaller artifact, use `make dist`: it xz-compresses the binary to
#   ~24 MB for transport; decompress on the target with `xz -d claude-router.xz`.

BIN      := claude-router
SRC      := router.mjs
DIST     := dist
OUT      := $(DIST)/$(BIN)

# Install location (override: `make install PREFIX=/usr/local`). The systemd unit
# below assumes the default user path (%h/.local/bin) — overriding PREFIX installs
# the binary elsewhere but the shipped unit will still point at ~/.local/bin.
PREFIX   ?= $(HOME)/.local
BINDIR   := $(PREFIX)/bin

# systemd user service + XDG config locations the unit reads from.
SERVICE   := claude-router.service
UNITDIR   := $(HOME)/.config/systemd/user
CONFDIR   := $(HOME)/.config/claude-router
CONF      := $(CONFDIR)/config.json
SYSTEMCTL := systemctl --user

BUN      := bun
BUNFLAGS := --compile --minify

.DEFAULT_GOAL := build
.PHONY: build install install-bin install-config install-service uninstall dist test clean help

build: $(OUT) ## Compile the single binary -> dist/claude-router

$(OUT): $(SRC)
	@mkdir -p $(DIST)
	$(BUN) build $(SRC) $(BUNFLAGS) --outfile $(OUT)
	@ls -l $(OUT) | awk '{printf "built %s (%.0f MB)\n", $$9, $$5/1048576}'

install: install-bin install-config install-service ## Build + install binary, config, and the systemd service
	@echo "install complete."

install-bin: build
	@mkdir -p $(BINDIR)
	install -m 755 $(OUT) $(BINDIR)/$(BIN)
	@echo "installed binary -> $(BINDIR)/$(BIN)"

install-config: ## Create ~/.config/claude-router/config.json if missing (migrates router.config.json)
	@mkdir -p $(CONFDIR)
	@if [ -f "$(CONF)" ]; then \
		echo "config exists: $(CONF) (left untouched)"; \
	elif [ -f router.config.json ]; then \
		cp router.config.json "$(CONF)"; \
		echo "migrated router.config.json -> $(CONF)"; \
	else \
		cp router.config.example.json "$(CONF)"; \
		echo "WARNING: created $(CONF) from the example — edit it (placeholders) before local routing works"; \
	fi

install-service: ## Install the unit, enable + (re)start the systemd --user service
	@mkdir -p $(UNITDIR)
	install -m 644 $(SERVICE) $(UNITDIR)/$(SERVICE)
	@echo "installed unit -> $(UNITDIR)/$(SERVICE)"
	@if command -v systemctl >/dev/null 2>&1; then \
		$(SYSTEMCTL) daemon-reload; \
		$(SYSTEMCTL) enable $(SERVICE); \
		$(SYSTEMCTL) restart $(SERVICE); \
		echo "service enabled and (re)started — status: $(SYSTEMCTL) status $(BIN)"; \
		echo "logs:  journalctl --user -u $(BIN) -f"; \
		echo "tip:   'loginctl enable-linger $$USER' keeps it running after logout"; \
	else \
		echo "systemctl not found — unit copied but not started"; \
	fi

uninstall: ## Stop/disable the service, remove binary + unit (config is kept)
	-@if command -v systemctl >/dev/null 2>&1; then \
		$(SYSTEMCTL) disable --now $(SERVICE) 2>/dev/null || true; \
	fi
	rm -f $(UNITDIR)/$(SERVICE)
	@command -v systemctl >/dev/null 2>&1 && $(SYSTEMCTL) daemon-reload || true
	rm -f $(BINDIR)/$(BIN)
	@echo "removed $(BINDIR)/$(BIN) and $(UNITDIR)/$(SERVICE) (config at $(CONF) kept)"

dist: build ## Compressed artifact for transport -> dist/claude-router.xz (~24 MB)
	xz -9 -f -k $(OUT)
	@ls -l $(OUT).xz | awk '{printf "packed %s (%.0f MB)\n", $$9, $$5/1048576}'
	@echo "decompress on target with: xz -d $(BIN).xz && chmod +x $(BIN)"

test: ## Run the test suite
	node tests/run.mjs

clean: ## Remove build output
	rm -rf $(DIST)

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'
