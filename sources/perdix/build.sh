#!/bin/zsh
# build.sh OUT: compiles the shot tool against a Perdix checkout and its build into OUT, e.g.
#   PERDIX=~/yt/emoton-perdix/583be78 PERDIX_BUILD=$PERDIX/build/shots ./build.sh bin/shot-583be78
# The build must hold the engine's and the app's static libraries (cmake --build ... --target perdix).
# From Code Typer's shots/perdix/build.sh, with the output named.
set -e
cd "$(dirname "$0")"
OUT=${1:?build.sh OUT}
P=${PERDIX:?PERDIX must name the Perdix checkout}; B=${PERDIX_BUILD:-$P/build/mac-release}; D=$B/_deps
[[ -d $D/glm-src ]] || D=$(dirname $(dirname $B))/_deps
DEPS=${PERDIX_DEPS:-$D}
INC=(-I . -I $P/app/src)
for m in core world mesh render minecraft; do INC+=(-I $P/engine/$m/include); done
INC+=(-I $B/engine/render/shaders/include)
for d in tracy-src/public vulkan_headers-src/include volk-src vma-src/include glm-src imgui-src yyjson-src/src tomlplusplus-src/include stb_image-src; do INC+=(-isystem $DEPS/$d); done
LIBS=($B/app/libvx_app_startup.a $B/app/libvx_app_view.a $B/app/libvx_app_play.a
      $B/engine/minecraft/libvx_minecraft.a $B/engine/minecraft/libvx_yyjson.a
      $B/engine/render/libvx_render.a $B/engine/mesh/libvx_mesh.a $B/engine/world/libvx_world.a
      $B/engine/world/libvx_tomlplusplus.a $B/engine/render/libvx_imgui_vulkan.a $B/engine/render/libvx_imgui.a
      $B/engine/render/libvx_vma.a $B/engine/render/libvx_volk.a $B/engine/core/libvx_stb_image.a
      $B/engine/core/libvx_core.a $B/engine/core/libvx_tracy.a)
mkdir -p "$(dirname "$OUT")"
/usr/bin/clang++ -std=c++20 -O2 -fno-exceptions -fno-rtti -DNDEBUG -DGLM_FORCE_DEPTH_ZERO_TO_ONE -DIMGUI_DISABLE_OBSOLETE_FUNCTIONS -DIMGUI_IMPL_VULKAN_USE_VOLK -DVK_NO_PROTOTYPES \
  "${INC[@]}" shot.cpp demo_chunk.cpp "${LIBS[@]}" -lz -o "$OUT"
echo "built $(pwd)/$OUT"
