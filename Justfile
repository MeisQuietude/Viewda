default:
    @just --list

# Prepare a fresh checkout for development.
setup:
    scripts/run.sh setup

# Run the complete local and CI verification gate.
check:
    scripts/run.sh check

# Check native code for the host operating system without building installers.
check-native:
    scripts/run.sh check-native

# Run Rust and frontend tests.
test:
    scripts/run.sh test

# Format Rust and frontend sources.
fmt:
    scripts/run.sh fmt

# Run the native desktop application.
dev:
    scripts/run.sh dev

# Build the installation bundle for the host operating system.
bundle:
    scripts/run.sh bundle

# Print and validate the development environment manifest.
doctor:
    scripts/run.sh doctor
