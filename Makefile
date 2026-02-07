.PHONY: commit
commit:
	@echo "Run auto-commit with: make commit MSG=\"your message\""
	@if [ -z "$(MSG)" ]; then \
		echo "Please provide MSG environment variable, e.g. make commit MSG=\"Fix bug\""; exit 1; \
	fi
	./scripts/auto-commit.sh "$(MSG)"
