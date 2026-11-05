#!/usr/bin/env bash
# Source from a Linux shell. Tools stay in the ignored workspace directory.
codec_repository=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
export EMSDK_QUIET=1
source "${OPENLR_EMSDK:-$codec_repository/.tools/emsdk}/emsdk_env.sh"
export PATH="$codec_repository/.tools/linux-build/cmake/data/bin:$codec_repository/.tools/linux-build/ninja-1.11.1.4.data/scripts:$PATH"
export OPENLR_BUILD_JOBS="${OPENLR_BUILD_JOBS:-4}"
