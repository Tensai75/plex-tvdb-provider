# Release the Docker image

1. Tag the reviewed commit on `main` and push the version tag. GitHub Actions builds, tests, and publishes the versioned image to GHCR. Stable tags also update `latest`.
2. For the first release, open the container package's **Package settings → Change visibility** and set it to **Public** so users can pull without credentials.
3. From a Docker client signed out of GHCR, pull both the versioned image and `latest`. Check that both tags resolve to the same digest before announcing the release.
