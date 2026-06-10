build-PropertyApiFunction:
	# Copy source code files
	cp app.py __init__.py $(ARTIFACTS_DIR)/
	# Copy spatial extension binary
	cp spatial.duckdb_extension $(ARTIFACTS_DIR)/
	# Install dependencies targeting AWS Lambda Python 3.11 / ARM64 / modern glibc
	python3 -m pip install -r requirements.txt -t $(ARTIFACTS_DIR) --only-binary=:all: --platform manylinux_2_28_aarch64 --platform manylinux_2_27_aarch64 --platform linux_aarch64 --python-version 312 --implementation cp --abi cp312
