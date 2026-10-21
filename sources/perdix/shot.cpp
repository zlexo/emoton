// Scratch tool (not engine code): Perdix shots for the Shorts, rendered headless by the real engine
// and written as raw RGBA frames back to back on stdout, for ffmpeg.
//
//   shot <cube|chunk|walk|fly> <width> <height> <frames> [fps]
//
// Each shot is one milestone, drawn by today's engine:
//   cube   M1  the renderer's own cube, RFC 0001's gray checker (FrameInputs::cubes)
//   blocks M2  an N by N by N cube of blocks put down one at a time (meshing, RFC 0003)
//   walk-search  no frames: tries walk starts and headings with the real movement and prints the ones
//              that never run into a step before the jumping starts
//   chunk  M2  the demo chunk (app/src/demo_chunk.cpp from before 3013a27); MINECRAFT=0 draws the
//              core pack's own textures (M2), the default the player's Minecraft (M2.5)
//   walk   M2.75  RFC 0010's movement on the placeholder hills, the app's camera: eye between
//              ticks, sprint FOV, view bobbing
//   fly    M3  a flight over the placeholder hills and their spires
//   stream M3  the same world streamed in around the camera: nothing at first, then columns load
//              nearest first within the view distance and unload behind, as the app's streamer
//              orders them (emulated here, so the timing is the shot's, not a thread's)
//   horizon-lod M9  RFC 0011's levels: the chunks drawn around a still camera to VIEW chunks (up to
//              512, 16,384 blocks), coarser with distance at quality K, each meshed from the
//              placeholder's cells at its own level; the camera turns by TURN (no fog yet, and no
//              border sets, so a seam can show where levels meet)
//   horizon M3  how far the world reaches: the columns within START chunks of the camera, Minecraft's
//              farthest at 16 of Perdix's chunks (512 blocks), then the view distance growing to VIEW
//              chunks from GROW_AT seconds over GROW while the camera rises and tips down (no fog yet:
//              the world ends at an edge)
//   perdix-born   M3.5  Perdix standing on a hill, the camera pushing in to his face: the missing
//              skin's magenta first, his name tag from TAG_AT seconds, his own skin from SKIN_AT
//   perdix-walk   M3.5  Perdix walking (sprinting from SPRINT_FROM, jumping from JUMP_FROM), the
//              camera tracking him from the side, his body animated as the game animates a player
//   perdix-stuck  M3.5  Perdix walking into a one block step and standing there, legs still
//              (start from stuck-search), the camera beside him
//   perdix-life   M4  Perdix living his life (RFC 0012: he strolls, looks around and at you, follows you,
//              climbs steps by auto-jump), from SEED, with you standing YOU_AHEAD blocks in front of where
//              he starts and YOU_SIDE to his right; MODE 0 his life, 1 following you, 2 standing still; CAM 0
//              beside him, 1 from your eyes, 2 a god's orbit; from STARE_FROM his head turns to the camera for STARE_FOR seconds,
//              at a mob's look pace (the shot picks the moment of a look his life makes on its own)
//   life-search   no frames: what each SEED's life does over the shot (strolls, looks, jumps), to pick one
//   (perdix-life and life-search need a Perdix with RFC 0012's life: built at an older commit they refuse)
// Meshing: MERGE=0 draws a quad per face, as before RFC 0003 merges faces that look alike.
// Animation: the chunk can build up a layer at a time (BUILD_LAYERS seconds) or merge its faces one
// direction at a time, top first (MERGE_SWEEP seconds); any orbit can fly in from DOLLY_FROM and tumble
// (TUMBLE: how far the height and the roll swing).
// Looks: WIREFRAME=1 draws edges only (MoltenVK offers it, KosmicKrisp does not); TEXTURES=0 binds
// no block textures, so every face takes the renderer's own checker.
// Environment: PERDIX (the checkout whose assets/ hold the core pack), FROM and TO (render part of
// the shot, for stills), and the knobs read by knob() below.
#include "demo_chunk.hpp"
#include "startup_pack.hpp"
#include "view.hpp"
#include "walking.hpp"

#include <vx/core/diagnostic.hpp>
#include <vx/core/file.hpp>
#include <vx/mesh/name_tag.hpp>
#include <vx/mesh/player_model.hpp>
#include <vx/minecraft/font_file.hpp>
#include <vx/minecraft/install.hpp>
#include <vx/minecraft/skin_file.hpp>
#include <vx/world/body_motion.hpp>
#include <vx/world/font.hpp>
#include <vx/world/skin.hpp>
#include <vx/mesh/mesh_chunk.hpp>
#include <vx/mesh/padded_chunk.hpp>
#include <vx/render/camera.hpp>
#include <vx/render/chunk_renderer.hpp>
#include <vx/render/chunk_uploads.hpp>
#include <vx/render/renderer.hpp>
#include <vx/world/block_registry.hpp>
#include <vx/world/block_state.hpp>
#include <vx/world/chunk_boxes.hpp>
#include <vx/world/chunk_storage.hpp>
#include <vx/world/collision.hpp>
#include <vx/world/coordinates.hpp>
#include <vx/world/generator.hpp>
#if __has_include(<vx/world/life.hpp>)
#include <vx/world/life.hpp>
#define SHOT_HAS_LIFE 1
#endif
#if __has_include(<vx/world/lod.hpp>)
#include <vx/world/lod.hpp>
#define SHOT_HAS_LOD 1 // RFC 0011's levels, drawn: Perdix 66f3ea1 and later
#endif
#include <vx/world/movement.hpp>
#include <vx/world/placeholder_generator.hpp>
#include <vx/world/region.hpp>

#include <glm/ext/vector_int3_sized.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <compare>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <map>
#include <memory>
#include <numbers>
#include <optional>
#include <set>
#include <span>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

namespace {

double knob(const char* name, double fallback) {
    const char* value = std::getenv(name);
    return value != nullptr ? std::atof(value) : fallback;
}

vx::MeshOptions mesh_options() {
    return {.merge = knob("MERGE", 1) != 0};
}

double smooth(double t) {
    t = std::clamp(t, 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

// Yaw and pitch that look along `d` (RFC 0001: yaw 0 looks down -z, positive turns left).
void look_along(vx::render::Camera& camera, double dx, double dy, double dz) {
    camera.yaw = static_cast<float>(std::atan2(-dx, -dz));
    camera.pitch = static_cast<float>(std::atan2(dy, std::hypot(dx, dz)));
}

struct Key {
    std::int32_t x = 0;
    std::int32_t y = 0;
    std::int32_t z = 0;
    auto operator<=>(const Key&) const = default;
};

// The placeholder's hills over a rectangle of chunk columns, for drawing and for walking. Chunks
// above a column's surface range are air; those under it are solid stone (the generator's own
// out_of_reach state), which both the mesher's borders and the player's feet need.
class World final : public vx::BlockBoxes {
public:
    // The columns cx0 to cx1 by cz0 to cz1, inclusive; with `disc` above 0 only those whose middle is
    // within `disc` chunks of the rectangle's middle. `collide` builds the boxes a body walks on.
    World(const vx::BlockRegistry& registry, const vx::PlaceholderGenerator& generator,
          std::int32_t cx0, std::int32_t cx1, std::int32_t cz0, std::int32_t cz1, double disc = 0.0,
          bool collide = true)
        : physics_(registry.physics()) {
        vx::GenScratch scratch;
        const auto started = std::chrono::steady_clock::now();
        const double mid_x = (cx0 + cx1) / 2.0, mid_z = (cz0 + cz1) / 2.0;
        for (std::int32_t cz = cz0; cz <= cz1; ++cz) {
            for (std::int32_t cx = cx0; cx <= cx1; ++cx) {
                if (disc > 0.0 && std::hypot(cx - mid_x, cz - mid_z) > disc) {
                    continue;
                }
                const vx::ChunkRange range = generator.surface_range({.x = cx, .z = cz}, scratch);
                ranges_[{cx, cz}] = range;
                for (std::int32_t cy = range.min_y; cy <= range.max_y; ++cy) {
                    const vx::ChunkPos pos{.x = cx, .y = cy, .z = cz};
                    if (const std::optional<vx::BlockState> fill = generator.out_of_reach(pos)) {
                        if (*fill != vx::BlockState::air) {
                            chunks_.emplace(Key{cx, cy, cz}, vx::ChunkStorage::uniform(*fill));
                        }
                        continue;
                    }
                    const vx::ChunkPlan plan = generator.plan(pos, scratch);
                    std::array<const vx::ChunkPlan*, 27> plans{};
                    plans.fill(&plan); // the placeholder's builds ignore their neighbors
                    chunks_.emplace(Key{cx, cy, cz}, generator.build(plans, scratch));
                }
                // the layer under the range, for the borders and the feet
                const vx::ChunkPos under{.x = cx, .y = range.min_y - 1, .z = cz};
                if (!stone_ && generator.out_of_reach(under)) {
                    stone_ = vx::ChunkStorage::uniform(*generator.out_of_reach(under));
                }
            }
        }
        for (const auto& [key, storage] : chunks_) {
            if (!collide) {
                break;
            }
            boxes_.emplace(key, std::make_unique<vx::ChunkBoxes>(
                                    storage, vx::ChunkPos{.x = key.x, .y = key.y, .z = key.z}, physics_));
        }
        std::cerr << "world: " << ranges_.size() << " columns, " << chunks_.size() << " chunks in "
                  << std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count()
                  << " s\n";
    }

    // The chunk at `key`: generated, solid under its column's surface, or null for air.
    [[nodiscard]] const vx::ChunkStorage* at(Key key) const {
        if (const auto found = chunks_.find(key); found != chunks_.end()) {
            return &found->second;
        }
        const auto column = ranges_.find({key.x, key.z});
        if (column != ranges_.end() && key.y < column->second.min_y && stone_) {
            return &*stone_;
        }
        return nullptr;
    }

    // Every chunk's mesh, its quads copied out of the mesher's scratch, which the next chunk reuses.
    struct Stored {
        vx::ChunkPos pos;
        std::vector<vx::Quad> quads;
        std::array<std::uint32_t, 12> counts{};
        std::uint8_t level = 0; // RFC 0011's
    };
    [[nodiscard]] std::vector<Stored> mesh(const vx::BlockRegistry& registry) const {
        auto padded = std::make_unique<vx::PaddedChunk>();
        vx::MeshScratch scratch;
        std::vector<Stored> out;
        std::size_t quads = 0;
        const auto started = std::chrono::steady_clock::now();
        for (const auto& [key, storage] : chunks_) {
            vx::ChunkNeighborhood neighborhood(storage);
            for (int dy = -1; dy <= 1; ++dy) {
                for (int dz = -1; dz <= 1; ++dz) {
                    for (int dx = -1; dx <= 1; ++dx) {
                        if (dx == 0 && dy == 0 && dz == 0) {
                            continue;
                        }
                        if (const vx::ChunkStorage* neighbor = at({key.x + dx, key.y + dy, key.z + dz})) {
                            neighborhood.set(dx, dy, dz, neighbor);
                        }
                    }
                }
            }
            vx::assemble_padded(neighborhood, *padded);
            const vx::ChunkMesh mesh = vx::mesh_chunk(*padded, registry.visuals(), scratch, mesh_options());
            if (mesh.all().empty()) {
                continue;
            }
            Stored stored{.pos = {.x = key.x, .y = key.y, .z = key.z}, .quads = {}, .counts = {}};
            stored.quads.assign(mesh.all().begin(), mesh.all().end());
            for (std::size_t pass = 0; pass < 2; ++pass) {
                for (std::size_t face = 0; face < 6; ++face) {
                    stored.counts[(pass * 6) + face] = static_cast<std::uint32_t>(mesh.ranges[pass][face].size());
                }
            }
            quads += stored.quads.size();
            out.push_back(std::move(stored));
        }
        std::cerr << "meshes: " << out.size() << ", quads " << quads << " in "
                  << std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count()
                  << " s\n";
        return out;
    }

    void collect(const vx::Box& region, std::vector<vx::Box>& out) const override {
        if (!std::isfinite(region.min.x) || !std::isfinite(region.max.x)) {
            return;
        }
        const auto chunk = [](double v) { return static_cast<std::int32_t>(std::floor(v)) >> vx::chunk_bits; };
        for (std::int32_t cy = chunk(region.min.y); cy <= chunk(region.max.y); ++cy) {
            for (std::int32_t cz = chunk(region.min.z); cz <= chunk(region.max.z); ++cz) {
                for (std::int32_t cx = chunk(region.min.x); cx <= chunk(region.max.x); ++cx) {
                    if (const auto found = boxes_.find({cx, cy, cz}); found != boxes_.end()) {
                        found->second->collect(region, out);
                    } else if (stone_ && at({cx, cy, cz}) == &*stone_) {
                        vx::ChunkBoxes(*stone_, vx::ChunkPos{.x = cx, .y = cy, .z = cz}, physics_)
                            .collect(region, out);
                    }
                }
            }
        }
    }

    [[nodiscard]] double slipperiness(vx::BlockPos block) const override {
        const vx::ChunkPos c = vx::chunk_of(block);
        if (const auto found = boxes_.find({c.x, c.y, c.z}); found != boxes_.end()) {
            return found->second->slipperiness(block);
        }
        return 0.6;
    }

private:
    std::span<const vx::BlockPhysics> physics_;
    std::map<std::pair<std::int32_t, std::int32_t>, vx::ChunkRange> ranges_;
    std::map<Key, vx::ChunkStorage> chunks_;
    std::map<Key, std::unique_ptr<vx::ChunkBoxes>> boxes_;
    std::optional<vx::ChunkStorage> stone_;
};

// The meshes on their way into the arena (RFC 0007), handed over in order each frame until the
// budget says later, as the app's StreamedMeshes does with the world thread's.
class Pending final : public vx::render::ChunkChanges {
public:
    explicit Pending(std::vector<World::Stored> meshes) : meshes_(std::move(meshes)) {}
    [[nodiscard]] vx::Result<void> apply(vx::render::ChunkUploader& uploader) override {
        while (next_ < meshes_.size()) {
            const World::Stored& stored = meshes_[next_];
            vx::ChunkMesh mesh{};
            std::size_t at = 0;
            for (std::size_t pass = 0; pass < 2; ++pass) {
                for (std::size_t face = 0; face < 6; ++face) {
                    const std::uint32_t count = stored.counts[(pass * 6) + face];
                    mesh.ranges[pass][face] = std::span<const vx::Quad>(stored.quads.data() + at, count);
                    at += count;
                }
            }
#ifdef SHOT_HAS_LOD
            const vx::Result<vx::render::Uploaded> uploaded =
                uploader.upload({.pos = stored.pos, .generation = 1, .mesh = mesh, .level = stored.level});
#else
            const vx::Result<vx::render::Uploaded> uploaded =
                uploader.upload({.pos = stored.pos, .generation = 1, .mesh = mesh});
#endif
            if (!uploaded) {
                return uploaded.error();
            }
            if (uploaded.value() == vx::render::Uploaded::later || uploaded.value() == vx::render::Uploaded::full) {
                if (uploaded.value() == vx::render::Uploaded::full) {
                    ++full_;
                }
                return {};
            }
            ++next_;
        }
        return {};
    }
    [[nodiscard]] bool done() const noexcept { return next_ == meshes_.size(); }
    [[nodiscard]] std::size_t left() const noexcept { return meshes_.size() - next_; }
    [[nodiscard]] std::size_t full() const noexcept { return full_; }

private:
    std::vector<World::Stored> meshes_;
    std::size_t next_ = 0;
    std::size_t full_ = 0;
};

#ifdef SHOT_HAS_LOD
// RFC 0011's levels around `eye`: every chunk lod_cover draws in the terrain's rows, its padded cells
// straight from the placeholder's rules at its own level (cell_height, then the cell rule lod_build
// uses: solid under the ground at the cell's middle, the block the top of its solid part has),
// meshed with corner shadows at level 0 alone. Chunks all air, or solid through their border, make
// no quads and are skipped before meshing.
std::vector<World::Stored> lod_meshes(const vx::PlaceholderGenerator& generator,
                                      const vx::PlaceholderBlocks& blocks, const vx::BlockRegistry& registry,
                                      const vx::LodRings& rings, const vx::Vec3d& eye) {
    const auto started = std::chrono::steady_clock::now();
    const std::vector<vx::LodPos> cover = vx::lod_cover(rings, eye, -1, 20);
    auto padded = std::make_unique<vx::PaddedChunk>();
    vx::MeshScratch scratch;
    std::vector<World::Stored> out;
    std::array<std::int32_t, vx::padded_size * vx::padded_size> heights{};
    std::array<std::size_t, vx::lod_levels> by_level{};
    std::size_t quads = 0;
    for (const vx::LodPos pos : cover) {
        const std::int64_t size = std::int64_t{1} << pos.level;
        for (int z = 0; z < vx::padded_size; ++z) {
            for (int x = 0; x < vx::padded_size; ++x) {
                heights[static_cast<std::size_t>(x + (z * vx::padded_size))] = generator.cell_height(
                    (std::int64_t{pos.x} * vx::chunk_size) + x - 1, (std::int64_t{pos.z} * vx::chunk_size) + z - 1,
                    pos.level);
            }
        }
        const auto [lowest, highest] = std::ranges::minmax(heights);
        const std::int64_t bottom_row = (std::int64_t{pos.y} * vx::chunk_size) - 1; // padded row 0
        if ((bottom_row * size) + (size / 2) >= highest) {
            continue; // air throughout
        }
        if (((bottom_row + vx::padded_size - 1) * size) + (size / 2) < lowest) {
            continue; // solid through its border: no face shows
        }
        for (int y = 0; y < vx::padded_size; ++y) {
            const std::int64_t row = bottom_row + y;
            const std::int64_t middle = (row * size) + (size / 2);
            const std::int64_t top = (row * size) + size - 1;
            for (int z = 0; z < vx::padded_size; ++z) {
                for (int x = 0; x < vx::padded_size; ++x) {
                    const std::int64_t ground = heights[static_cast<std::size_t>(x + (z * vx::padded_size))];
                    vx::BlockState block = vx::BlockState::air;
                    if (middle < ground) {
                        const std::int64_t shown = std::min(top, ground - 1);
                        if (ground == vx::PlaceholderGenerator::spire_height ||
                            shown < ground - (vx::PlaceholderGenerator::dirt_depth + 1)) {
                            block = blocks.stone;
                        } else if (shown < ground - 1) {
                            block = blocks.dirt;
                        } else {
                            block = blocks.grass;
                        }
                    }
                    padded->blocks[vx::padded_index(x, y, z)] = block;
                }
            }
        }
        const vx::ChunkMesh mesh =
            vx::mesh_chunk(*padded, registry.visuals(), scratch, {.merge = true, .occlusion = pos.level == 0});
        if (mesh.all().empty()) {
            continue;
        }
        World::Stored stored{.pos = {.x = pos.x, .y = pos.y, .z = pos.z}, .quads = {}, .counts = {}, .level = pos.level};
        stored.quads.assign(mesh.all().begin(), mesh.all().end());
        for (std::size_t pass = 0; pass < 2; ++pass) {
            for (std::size_t face = 0; face < 6; ++face) {
                stored.counts[(pass * 6) + face] = static_cast<std::uint32_t>(mesh.ranges[pass][face].size());
            }
        }
        quads += stored.quads.size();
        ++by_level[pos.level];
        out.push_back(std::move(stored));
    }
    std::cerr << "lod: " << cover.size() << " chunks drawn, " << out.size() << " with quads (by level:";
    for (const std::size_t count : by_level) {
        std::cerr << ' ' << count;
    }
    std::cerr << "), " << quads << " quads, in "
              << std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count() << " s\n";
    return out;
}
#endif

// The streamed world as the shot shows it (RFC 0006): every frame wants the columns whose middle
// is within `radius` blocks of the camera, loads the nearest first (at most `per_frame` columns),
// and unloads those past `drop_radius`.
class Stream final : public vx::render::ChunkChanges {
public:
    using Column = std::pair<std::int32_t, std::int32_t>;
    explicit Stream(std::vector<World::Stored> meshes) {
        for (World::Stored& stored : meshes) {
            columns_[{stored.pos.x, stored.pos.z}].push_back(std::move(stored));
        }
    }
    void want(double x, double z, double radius, double drop_radius, std::size_t per_frame) {
        std::vector<std::pair<double, Column>> wanted;
        for (const auto& [column, stored] : columns_) {
            const double d = std::hypot(column.first * 32.0 + 16.0 - x, column.second * 32.0 + 16.0 - z);
            const bool in = loaded_.contains(column);
            if (!in && d < radius) {
                wanted.emplace_back(d, column);
            } else if (in && d > drop_radius) {
                loaded_.erase(column);
                for (const World::Stored& s : stored) {
                    removals_.push_back(s.pos);
                }
            }
        }
        std::sort(wanted.begin(), wanted.end());
        for (std::size_t i = 0, taken = 0; i < wanted.size() && taken < per_frame; ++i) {
            if (queued_.insert(wanted[i].second).second) {
                queue_.push_back(wanted[i].second);
                ++taken;
            }
        }
    }
    [[nodiscard]] vx::Result<void> apply(vx::render::ChunkUploader& uploader) override {
        for (const vx::ChunkPos pos : removals_) {
            uploader.remove(pos);
        }
        removals_.clear();
        std::size_t done = 0;
        for (const Column& column : queue_) {
            bool all = true;
            for (const World::Stored& stored : columns_.at(column)) {
                vx::ChunkMesh mesh{};
                std::size_t at = 0;
                for (std::size_t pass = 0; pass < 2; ++pass) {
                    for (std::size_t face = 0; face < 6; ++face) {
                        const std::uint32_t count = stored.counts[(pass * 6) + face];
                        mesh.ranges[pass][face] = std::span<const vx::Quad>(stored.quads.data() + at, count);
                        at += count;
                    }
                }
                const vx::Result<vx::render::Uploaded> uploaded =
                    uploader.upload({.pos = stored.pos, .generation = ++generation_, .mesh = mesh});
                if (!uploaded) {
                    return uploaded.error();
                }
                if (uploaded.value() == vx::render::Uploaded::later || uploaded.value() == vx::render::Uploaded::full) {
                    all = false;
                    break;
                }
            }
            if (!all) {
                break;
            }
            loaded_.insert(column);
            queued_.erase(column);
            ++done;
        }
        queue_.erase(queue_.begin(), queue_.begin() + static_cast<std::ptrdiff_t>(done));
        return {};
    }
    [[nodiscard]] std::size_t loaded() const noexcept { return loaded_.size(); }

private:
    std::map<Column, std::vector<World::Stored>> columns_;
    std::set<Column> loaded_;
    std::vector<Column> queue_;
    std::set<Column> queued_;
    std::vector<vx::ChunkPos> removals_;
    std::uint32_t generation_ = 0;
};

// The keys of the walk's tick `tick`: forward always, the sprint key from SPRINT_FROM, Space held from
// JUMP_FROM (the game repeats a held jump on landing), and with HOP=1 a hop up any step that stops the
// player before then, as a player would.
vx::TickInput walk_input(std::uint64_t tick, double yaw, const vx::Player& player) {
    const double at = static_cast<double>(tick) / 20.0;
    vx::TickInput input;
    input.held.forward = true;
    input.held.sprint = at >= knob("SPRINT_FROM", 0.0);
    input.held.jump = at >= knob("JUMP_FROM", 0.35) ||
                      (knob("HOP", 1) != 0 && player.horizontal_collision && !player.minor_horizontal_collision);
    input.yaw = static_cast<float>(yaw);
    return input;
}
double walk_yaw(double base, double seconds) {
    return base + knob("SWAY", 0.18) * std::sin(seconds * 0.9);
}

// A skin from the core pack (RFC 0012): Perdix's own or the owner's.
std::optional<vx::Skin> pack_skin(const char* root, const char* name, vx::Arms arms) {
    const std::optional<std::string> png =
        vx::read_file(std::string(root) + "/assets/core/textures/entity/player/" + name + ".png");
    if (!png) {
        std::cerr << "no skin " << name << '\n';
        return std::nullopt;
    }
    const vx::Result<vx::Skin> skin = vx::minecraft::read_skin(
        std::as_bytes(std::span(png->data(), png->size())), arms);
    if (!skin) {
        std::cerr << name << ": " << skin.error().message << '\n';
        return std::nullopt;
    }
    return skin.value();
}

// Perdix (RFC 0012): RFC 0010's movement with a body, animated each tick as the game animates a
// player, posed between ticks.
struct Figure {
    std::unique_ptr<vx::app::Walking> walking;
    vx::BodyMotion previous{};
    vx::BodyMotion motion{};

    // One tick with `input`, its look along `look_yaw` and `look_pitch`, then the body's animation.
    void tick(const vx::TickInput& input, const vx::BlockBoxes& world, float look_yaw, float look_pitch) {
        walking->tick(input, world);
        const vx::app::WalkingFrame& frame = walking->frame();
        previous = motion;
        vx::animate(motion, frame.position - frame.previous, look_yaw, look_pitch);
    }

    // The pose `between` (0 to 1) of the way from the last tick to the next, `age` ticks old.
    vx::PlayerPose pose(double between, double age, std::uint32_t skin) const {
        const vx::app::WalkingFrame& frame = walking->frame();
        const vx::BodyAt at = vx::body_at(previous, motion, between);
        return {.feet = frame.previous + (frame.position - frame.previous) * between,
                .limb_position = at.limb_position,
                .limb_amount = at.limb_amount,
                .age = age,
                .body_yaw = at.body_yaw,
                .head_yaw = at.head_yaw,
                .head_pitch = at.head_pitch,
                .skin = skin,
                .arms = vx::Arms::wide,
                .crouching = frame.crouching};
    }
};

#ifdef SHOT_HAS_LIFE
// A point a block from `eye` along a look (the engine's yaw, the pitch positive looking up), for a look
// control to look at.
vx::Vec3d look_point(vx::Vec3d eye, float yaw, float pitch) {
    const double y = yaw, p = pitch;
    return eye + vx::Vec3d{.x = -std::sin(y) * std::cos(p), .y = std::sin(p), .z = -std::cos(y) * std::cos(p)};
}

// One tick of Perdix's life as the app's world loop runs it (WorldLoop::tick_perdix): the life's choice,
// the move with its look, then the auto-jump's look ahead. His head follows a look control of its own, a
// mob's 10 degrees a tick, toward where his life looks, or toward `stare` while there is one.
void life_tick(vx::Life& life, vx::app::Walking& w, const vx::Onlooker& you, const vx::BlockBoxes& world,
               std::vector<vx::Box>& scratch, vx::LookControl& head, const vx::Vec3d* stare) {
    const vx::LifeTick choice = life.tick(w.player(), w.frame().motion.body_yaw, you, world, scratch);
    const vx::Vec3d before = w.player().position;
    const vx::Vec3d eye = before + vx::Vec3d{.x = 0.0, .y = vx::eye_height(w.player().pose), .z = 0.0};
    head.look_at(stare != nullptr ? *stare : look_point(eye, choice.look_yaw, choice.look_pitch));
    head.tick(eye, w.frame().motion.body_yaw, life.walk_target().has_value());
    w.tick(choice.input, world, head.yaw(), head.pitch());
    life.after_move(w.player(), w.player().position - before, world, scratch);
}
#endif

// The app's daytime sky, #78A7FF in sRGB.
constexpr vx::render::Color sky = {.r = 0.188F, .g = 0.386F, .b = 1.0F, .a = 1.0F};

} // namespace

int main(int argc, char** argv) {
    if (argc < 5) {
        std::cerr << "shot <cube|chunk|walk|fly> width height frames [fps]\n";
        return 2;
    }
    const std::string shot = argv[1];
    const auto width = static_cast<std::uint32_t>(std::atoi(argv[2]));
    const auto height = static_cast<std::uint32_t>(std::atoi(argv[3]));
    const int frames = std::atoi(argv[4]);
    const double fps = argc > 5 ? std::atof(argv[5]) : 60.0;
    const int from = static_cast<int>(knob("FROM", 0));
    const int to = static_cast<int>(knob("TO", frames));
    const char* root = std::getenv("PERDIX");
    if (root == nullptr) {
        std::cerr << "PERDIX must name the Perdix checkout\n";
        return 2;
    }

    // The block pack as the app loads it (RFC 0004, RFC 0009).
    vx::app::MinecraftChoice choice;
    choice.use = knob("MINECRAFT", 1) != 0;
    if (const char* home = std::getenv("HOME")) {
        choice.query.home = home;
    }
    const vx::app::StartupPack startup = vx::app::load_startup_pack(root, choice);
    std::cerr << startup.textures << '\n';
    for (const vx::Diagnostic& diagnostic : startup.pack.diagnostics) {
        std::cerr << vx::format(diagnostic) << '\n';
    }
    if (!startup.pack.registry) {
        return 1;
    }
    const vx::BlockRegistry& registry = *startup.pack.registry;

    if (shot == "stuck-search") {
        // walking (no sprint, no hop) into a step that stops the player between STOP_MIN and STOP_MAX
        // seconds, one block high: a jump STUCK_FOR seconds after the stop gets it going again
        const vx::PlaceholderGenerator gen(0x5EED, {.grass = *registry.find("core:grass"),
                                                    .dirt = *registry.find("core:dirt"),
                                                    .stone = *registry.find("core:stone")});
        const World world(registry, gen, static_cast<std::int32_t>(knob("CX0", -12)), static_cast<std::int32_t>(knob("CX1", 44)),
                          static_cast<std::int32_t>(knob("CZ0", -14)), static_cast<std::int32_t>(knob("CZ1", 16)));
        struct Found { double x, z, yaw, stop, after; };
        std::vector<Found> found;
        const double step = knob("STEP", 24);
        for (double z = knob("ZMIN", -300); z <= knob("ZMAX", 360); z += step) {
            for (double x = knob("XMIN", 40); x <= knob("XMAX", 900); x += step) {
                for (int d = 0; d < 16; ++d) {
                    const double base = d * std::numbers::pi / 8;
                    vx::app::Walking w(vx::Vec3d{.x = x + 0.5, .y = static_cast<double>(gen.height(static_cast<std::int32_t>(x), static_cast<std::int32_t>(z))), .z = z + 0.5}, -64.0);
                    double stop = -1;
                    vx::Vec3d at_jump{}, settled{};
                    bool ok = true, have_settled = false;
                    for (std::uint64_t k = 0; k < static_cast<std::uint64_t>(20 * knob("SEARCH_SECONDS", 6.0)) && ok; ++k) {
                        const double sec = static_cast<double>(k) / 20.0;
                        const vx::Player& was = w.player();
                        if (stop < 0 && was.horizontal_collision && !was.minor_horizontal_collision) {
                            stop = sec;
                            if (stop < knob("STOP_MIN", 0.8) || stop > knob("STOP_MAX", 1.6)) ok = false;
                        }
                        // the jump: at STUCK_UNTIL when set (the line that says so), else STUCK_FOR after the stop
                        const double jump_at = std::getenv("STUCK_UNTIL") != nullptr ? knob("STUCK_UNTIL", 5.0) : stop + knob("STUCK_FOR", 1.5);
                        const bool jump = stop >= 0 && sec >= jump_at;
                        if (stop >= 0 && !have_settled && sec >= stop + 0.3) { settled = was.position; have_settled = true; }
                        if (jump && at_jump.x == 0 && at_jump.z == 0) {
                            at_jump = was.position;
                            // stuck means stuck: no sliding along the step between the stop and the jump
                            if (!have_settled || std::hypot(at_jump.x - settled.x, at_jump.z - settled.z) > knob("SLIDE_MAX", 0.25)) ok = false;
                        }
                        vx::TickInput input;
                        input.held.forward = true;
                        input.held.jump = jump;
                        input.yaw = static_cast<float>(base);
                        w.tick(input, world);
                    }
                    if (!ok || stop < 0 || (at_jump.x == 0 && at_jump.z == 0)) continue;
                    const double after = std::hypot(w.player().position.x - at_jump.x, w.player().position.z - at_jump.z);
                    if (after < knob("AFTER_MIN", 3.0)) continue; // a wall, not a step
                    found.push_back({x + 0.5, z + 0.5, base, stop, after});
                }
            }
        }
        std::cerr << found.size() << " walks that stop at a step and go on after a jump\n";
        for (std::size_t i = 0; i < found.size() && i < 12; ++i) {
            std::printf("WALK_X=%.1f WALK_Z=%.1f WALK_YAW=%.4f  stops at %.2f s, %.1f blocks after the jump\n", found[i].x, found[i].z, found[i].yaw, found[i].stop, found[i].after);
        }
        return found.empty() ? 1 : 0;
    }
    if (shot == "life-search" || shot == "perdix-life") {
#ifndef SHOT_HAS_LIFE
        std::cerr << shot << " needs a Perdix with RFC 0012's life (main from #380); this tool was built without it\n";
        return 2;
#endif
    }
#ifdef SHOT_HAS_LIFE
    if (shot == "life-search") {
        // SEEDS seeds from SEED_FROM, each Perdix's life at PERDIX_X, PERDIX_Z facing PERDIX_YAW with you
        // where perdix-life puts you, in MODE, over WARMUP plus the shot: when he strolls, looks at you or
        // around, and jumps, and how far he goes
        const vx::PlaceholderGenerator gen(0x5EED, {.grass = *registry.find("core:grass"),
                                                    .dirt = *registry.find("core:dirt"),
                                                    .stone = *registry.find("core:stone")});
        const World world(registry, gen, static_cast<std::int32_t>(knob("CX0", -12)), static_cast<std::int32_t>(knob("CX1", 44)),
                          static_cast<std::int32_t>(knob("CZ0", -14)), static_cast<std::int32_t>(knob("CZ1", 16)));
        const double px = knob("PERDIX_X", 60.5), pz = knob("PERDIX_Z", 40.5);
        const auto yaw = static_cast<float>(knob("PERDIX_YAW", 0.0));
        const double ahead = knob("YOU_AHEAD", 4.0), right = knob("YOU_SIDE", 0.0);
        const double ux = px - ahead * std::sin(yaw) + right * std::cos(yaw), uz = pz - ahead * std::cos(yaw) - right * std::sin(yaw);
        const vx::Onlooker you{.feet = {.x = ux, .y = static_cast<double>(gen.height(static_cast<std::int32_t>(std::floor(ux)), static_cast<std::int32_t>(std::floor(uz)))), .z = uz},
                               .eye_height = 1.62,
                               .sneaking = knob("YOU_SNEAK", 0) != 0};
        const double warm = knob("WARMUP", 0.0);
        const auto ticks = static_cast<std::uint64_t>((warm + frames / fps) * 20.0) + 1;
        std::vector<vx::Box> scratch;
        for (auto seed = static_cast<std::uint64_t>(knob("SEED_FROM", 1)); seed < static_cast<std::uint64_t>(knob("SEED_FROM", 1) + knob("SEEDS", 20)); ++seed) {
            vx::app::Walking w(vx::Vec3d{.x = px, .y = static_cast<double>(gen.height(static_cast<std::int32_t>(std::floor(px)), static_cast<std::int32_t>(std::floor(pz)))), .z = pz}, -64.0);
            w.set_may_fly(false);
            w.face(yaw, 0.0F);
            vx::Life life(seed, yaw);
            life.set_mode(static_cast<vx::LifeMode>(static_cast<int>(knob("MODE", 0))));
            vx::LookControl head(yaw);
            std::string strolls, stares, arounds, jumps;
            std::uint64_t s0 = 0, l0 = 0, a0 = 0;
            bool ground = true;
            for (std::uint64_t k = 0; k < ticks; ++k) {
                life_tick(life, w, you, world, scratch, head, nullptr);
                const double at = static_cast<double>(k) / 20.0 - warm;
                const auto mark = [&](std::string& into, vx::LifeGoal g, std::uint64_t& was) {
                    if (life.starts(g) != was) {
                        was = life.starts(g);
                        if (at >= 0) into += std::to_string(std::lround(at * 10) / 10.0).substr(0, 4) + " ";
                    }
                };
                mark(strolls, vx::LifeGoal::stroll, s0);
                mark(stares, vx::LifeGoal::look_at_player, l0);
                mark(arounds, vx::LifeGoal::look_around, a0);
                if (ground && !w.frame().on_ground && w.frame().vertical_speed() > 0 && at >= 0) jumps += std::to_string(std::lround(at * 10) / 10.0).substr(0, 4) + " ";
                ground = w.frame().on_ground;
            }
            const vx::Vec3d end = w.player().position;
            std::printf("SEED=%llu  strolls %s| looks at you %s| looks around %s| jumps %s| ends %.1f blocks away\n",
                        static_cast<unsigned long long>(seed), strolls.c_str(), stares.c_str(), arounds.c_str(), jumps.c_str(), std::hypot(end.x - px, end.z - pz));
        }
        return 0;
    }
#endif
    if (shot == "walk-search") {
        const vx::PlaceholderGenerator gen(0x5EED, {.grass = *registry.find("core:grass"),
                                                    .dirt = *registry.find("core:dirt"),
                                                    .stone = *registry.find("core:stone")});
        const World world(registry, gen, static_cast<std::int32_t>(knob("CX0", -12)), static_cast<std::int32_t>(knob("CX1", 44)),
                          static_cast<std::int32_t>(knob("CZ0", -14)), static_cast<std::int32_t>(knob("CZ1", 16)));
        const auto ticks = static_cast<std::uint64_t>(frames / fps * 20.0) + 1;
        const double jump_from = knob("JUMP_FROM", 0.35);
        struct Found { double score, x, z, yaw, walked, spire; };
        std::vector<Found> found;
        const double step = knob("STEP", 24);
        for (double z = knob("ZMIN", -300); z <= knob("ZMAX", 360); z += step) {
            for (double x = knob("XMIN", 40); x <= knob("XMAX", 900); x += step) {
                for (int d = 0; d < 16; ++d) {
                    const double base = d * std::numbers::pi / 8;
                    vx::app::Walking w(vx::Vec3d{.x = x + 0.5, .y = static_cast<double>(gen.height(static_cast<std::int32_t>(x), static_cast<std::int32_t>(z))), .z = z + 0.5}, -64.0);
                    bool stopped = false;
                    for (std::uint64_t k = 0; k < ticks && !stopped; ++k) {
                        const vx::Player& was = w.player();
                        if (static_cast<double>(k) / 20.0 < jump_from + 0.5 && was.horizontal_collision && !was.minor_horizontal_collision) {
                            stopped = true; // a step in the way while walking or sprinting
                        }
                        vx::TickInput input = walk_input(k, walk_yaw(base, static_cast<double>(k) / 20.0), was);
                        input.held.jump = static_cast<double>(k) / 20.0 >= jump_from; // no hops while searching
                        w.tick(input, world);
                    }
                    if (stopped) continue;
                    const vx::Player& end = w.player();
                    const double walked = std::hypot(end.position.x - (x + 0.5), end.position.z - (z + 0.5));
                    // a spire ahead: the nearest spire's middle, against the heading (yaw 0 looks down -z)
                    const double sxm = std::round((x - 8) / 512.0) * 512.0 + 8, szm = std::round((z - 8) / 512.0) * 512.0 + 8;
                    const double toward = std::atan2(-(sxm - x), -(szm - z));
                    double off = std::remainder(toward - base, 2 * std::numbers::pi);
                    const double dist = std::hypot(sxm - x, szm - z);
                    const double spire = (std::abs(off) < 0.45 && dist > 90 && dist < 420) ? 1.0 - std::abs(off) : 0.0;
                    found.push_back({walked + 30 * spire, x, z, base, walked, spire});
                }
            }
        }
        std::sort(found.begin(), found.end(), [](const Found& a, const Found& b) { return a.score > b.score; });
        std::cerr << found.size() << " clear walks\n";
        for (std::size_t i = 0; i < found.size() && i < 12; ++i) {
            std::printf("WALK_X=%.1f WALK_Z=%.1f WALK_YAW=%.4f  walked %.1f, spire %.2f\n", found[i].x + 0.5, found[i].z + 0.5, found[i].yaw, found[i].walked, found[i].spire);
        }
        return found.empty() ? 1 : 0;
    }

    // Perdix's skin and the owner's (RFC 0012), and the game's font from the player's jar for name
    // tags: never committed, read at run time as the app reads the game's textures. MINECRAFT=0
    // draws no tags.
    std::vector<vx::Skin> skins;
    for (const auto& [name, arms] : {std::pair{"perdix", vx::Arms::wide}, std::pair{"zlex", vx::Arms::slim}}) {
        if (std::optional<vx::Skin> skin = pack_skin(root, name, arms)) {
            skins.push_back(*skin);
        } else {
            return 1;
        }
    }
    std::unique_ptr<vx::Font> font;
    if (choice.use) {
        std::vector<vx::Diagnostic> found_diagnostics;
        vx::Result<vx::minecraft::Install> install = vx::minecraft::find_install(choice.query, found_diagnostics);
        if (install) {
            vx::Result<vx::Font> read = vx::minecraft::default_font(install.value().jar);
            if (read) {
                font = std::make_unique<vx::Font>(read.value());
            } else {
                std::cerr << "font: " << read.error().message << '\n';
            }
        }
    }

    vx::Result<vx::render::Renderer> made = vx::render::Renderer::create(
        {.surface = std::nullopt,
         .framebuffer = {.width = width, .height = height},
         .validation = knob("VALIDATION", 0) != 0,
         .present_mode = vx::render::PresentMode::fifo,
         .overlay = nullptr,
         .block_textures = knob("TEXTURES", 1) != 0 ? startup.pack.textures : std::span<const std::byte>{},
         .skins = skins,
         .font = font.get(),
         .chunk_arena_quads = std::uint32_t{1} << 24U,
         .chunk_arena_limit = 0,
         .stage_chunk_uploads = false,
         .draw_call_limit = 0});
    if (!made) {
        std::cerr << made.error().message << '\n';
        return 1;
    }
    vx::render::Renderer& renderer = made.value();
    renderer.set_wireframe(knob("WIREFRAME", 0) != 0);
    if (knob("WIREFRAME", 0) != 0 && !renderer.wireframe_offered()) {
        std::cerr << "this driver offers no wireframe (MoltenVK does)\n";
        return 1;
    }

    // What each shot needs before its frames.
    std::vector<glm::i64vec3> cubes;
    std::unique_ptr<World> world;
    std::unique_ptr<vx::app::Walking> walking;
    Figure figure;
#ifdef SHOT_HAS_LIFE
    // perdix-life: his life, you, the boxes its ticks gather, his head's own look control, the camera's
    // heading and aim as they ease after him, and where the camera was (what a stare looks at)
    std::unique_ptr<vx::Life> life;
    vx::Onlooker you{};
    std::vector<vx::Box> life_scratch;
    vx::LookControl head(0.0F);
    double cam_heading = 0.0;
    vx::Vec3d cam_aim{};
    vx::Vec3d last_camera{};
    bool cam_started = false;
#endif
    std::array<vx::PlayerPose, 1> poses{};
    std::array<vx::Tag, 1> tags{};
    std::size_t posed = 0;
    std::size_t tagged = 0;
    std::unique_ptr<Pending> pending;
    std::unique_ptr<Stream> stream;
    std::unique_ptr<std::array<vx::BlockState, vx::chunk_volume>> demo_dense;
    World::Stored faces_mesh{}, merged_mesh{};
    double sx = knob("X0", 0.0), sz = knob("Z0", 40.0); // the stream camera, integrated frame by frame
    const auto ground = [&]() {
        return vx::PlaceholderBlocks{.grass = *registry.find("core:grass"),
                                     .dirt = *registry.find("core:dirt"),
                                     .stone = *registry.find("core:stone")};
    };
    const vx::PlaceholderGenerator generator(0x5EED, ground()); // the app's seed
    if (shot == "cube") {
        cubes.push_back({0, 0, 0});
    } else if (shot == "blocks") {
        // rebuilt every frame below
    } else if (shot == "chunk") {
        const vx::Result<vx::ChunkStorage> chunk = vx::app::demo_chunk(registry);
        if (!chunk) {
            std::cerr << chunk.error().message << '\n';
            return 1;
        }
        demo_dense = std::make_unique<std::array<vx::BlockState, vx::chunk_volume>>();
        chunk.value().to_dense(*demo_dense);
        auto padded = std::make_unique<vx::PaddedChunk>();
        vx::assemble_padded(vx::ChunkNeighborhood(chunk.value()), *padded);
        vx::MeshScratch scratch;
        const vx::ChunkMesh mesh = vx::mesh_chunk(*padded, registry.visuals(), scratch, mesh_options());
        // both meshes of the whole chunk, copied out, for the merge sweep
        for (const bool merge : {false, true}) {
            vx::MeshScratch s;
            const vx::ChunkMesh m = vx::mesh_chunk(*padded, registry.visuals(), s, {.merge = merge});
            World::Stored& kept = merge ? merged_mesh : faces_mesh;
            kept.quads.assign(m.all().begin(), m.all().end());
            for (std::size_t pass = 0; pass < 2; ++pass) {
                for (std::size_t face = 0; face < 6; ++face) {
                    kept.counts[(pass * 6) + face] = static_cast<std::uint32_t>(m.ranges[pass][face].size());
                }
            }
        }
        std::cerr << "demo chunk: " << mesh.all().size() << " quads (merge " << knob("MERGE", 1) << ")\n";
        if (!renderer.set_chunk({.x = 0, .y = 0, .z = 0}, mesh)) {
            return 1;
        }
    } else if (shot == "stream") {
        world = std::make_unique<World>(registry, generator, static_cast<std::int32_t>(knob("CX0", -12)),
                                        static_cast<std::int32_t>(knob("CX1", 44)),
                                        static_cast<std::int32_t>(knob("CZ0", -14)),
                                        static_cast<std::int32_t>(knob("CZ1", 16)));
        stream = std::make_unique<Stream>(world->mesh(registry));
        renderer.set_chunk_budget(std::chrono::seconds(10));
    } else if (shot == "horizon") {
        // every column within VIEW chunks of the camera's, meshed once; the blocks go once meshed
        const double view = knob("VIEW", 64.0);
        const auto cx = static_cast<std::int32_t>(std::floor(knob("X0", 0.0) / 32.0));
        const auto cz = static_cast<std::int32_t>(std::floor(knob("Z0", 0.0) / 32.0));
        const auto reach = static_cast<std::int32_t>(std::ceil(view));
        world = std::make_unique<World>(registry, generator, cx - reach, cx + reach, cz - reach, cz + reach,
                                        view + 0.75, false);
        stream = std::make_unique<Stream>(world->mesh(registry));
        world.reset();
        renderer.set_chunk_budget(std::chrono::seconds(10));
    } else if (shot == "horizon-lod") {
#ifdef SHOT_HAS_LOD
        // The rings as the app at H rows would draw them, whatever this shot's size.
        vx::LodRings rings;
        rings.pixels_per_cell = knob("K", 4.0);
        rings.framebuffer_height = static_cast<std::uint32_t>(knob("H", 1440.0));
        rings.fov_y = knob("FOV", 70.0) * std::numbers::pi / 180.0;
        rings.view_distance = static_cast<std::int32_t>(knob("VIEW", 512.0));
        pending = std::make_unique<Pending>(lod_meshes(generator, ground(), registry, rings,
                                                       {.x = knob("X0", 0.5), .y = knob("Y0", 300.0), .z = knob("Z0", 0.5)}));
        renderer.set_chunk_budget(std::chrono::seconds(10));
        vx::render::Camera warm;
        int warmups = 0;
        while (!pending->done()) {
            if (!renderer.render({.sky = sky, .camera = warm, .cubes = {}, .overlay = nullptr, .chunk_changes = pending.get()})) {
                std::cerr << "upload frame failed\n";
                return 1;
            }
            if (++warmups > 400 || pending->full() > 100) {
                std::cerr << "uploads stuck: " << pending->left() << " left, full " << pending->full() << '\n';
                return 1;
            }
        }
        std::cerr << "uploaded in " << warmups << " frames\n";
#else
        std::cerr << "horizon-lod needs a Perdix with RFC 0011's levels drawn (66f3ea1 or later)\n";
        return 1;
#endif
    } else if (shot == "walk" || shot == "fly" || shot.starts_with("perdix-")) {
        // chunk columns, inclusive, from the knobs (in chunks); a flight SHIFT_X blocks east takes its
        // columns along
        const auto shift = shot == "fly" ? static_cast<std::int32_t>(std::lround(knob("SHIFT_X", 0.0) / 32.0)) : 0;
        world = std::make_unique<World>(registry, generator, static_cast<std::int32_t>(knob("CX0", -8)) + shift,
                                        static_cast<std::int32_t>(knob("CX1", 40)) + shift,
                                        static_cast<std::int32_t>(knob("CZ0", -14)),
                                        static_cast<std::int32_t>(knob("CZ1", 16)));
        pending = std::make_unique<Pending>(world->mesh(registry));
        // A whole world at once: the frames before the shot upload it, each with a budget no frame
        // of the app would get, until every mesh is in the arena.
        renderer.set_chunk_budget(std::chrono::seconds(10));
        vx::render::Camera warm;
        int warmups = 0;
        while (!pending->done()) {
            if (!renderer.render({.sky = sky, .camera = warm, .cubes = {}, .overlay = nullptr, .chunk_changes = pending.get()})) {
                std::cerr << "upload frame failed\n";
                return 1;
            }
            if (++warmups > 200 || pending->full() > 50) {
                std::cerr << "uploads stuck: " << pending->left() << " left, full " << pending->full() << '\n';
                return 1;
            }
        }
        std::cerr << "uploaded in " << warmups << " frames\n";
        if (shot.starts_with("perdix-")) {
            const double px = knob("PERDIX_X", 60.5);
            const double pz = knob("PERDIX_Z", 40.5);
            const auto bx = static_cast<std::int32_t>(std::floor(px));
            const auto bz = static_cast<std::int32_t>(std::floor(pz));
            figure.walking = std::make_unique<vx::app::Walking>(
                vx::Vec3d{.x = px, .y = static_cast<double>(generator.height(bx, bz)), .z = pz}, -64.0);
            const auto yaw = static_cast<float>(knob("PERDIX_YAW", 0.0));
            figure.motion = vx::body_facing(yaw, 0.0F);
            figure.previous = figure.motion;
#ifdef SHOT_HAS_LIFE
            if (shot == "perdix-life") {
                figure.walking->set_may_fly(false);
                figure.walking->face(yaw, 0.0F);
                life = std::make_unique<vx::Life>(static_cast<std::uint64_t>(knob("SEED", 1)), yaw);
                life->set_mode(static_cast<vx::LifeMode>(static_cast<int>(knob("MODE", 0))));
                head = vx::LookControl(yaw);
                cam_heading = yaw;
                const double ahead = knob("YOU_AHEAD", 4.0), right = knob("YOU_SIDE", 0.0);
                const double ux = px - ahead * std::sin(yaw) + right * std::cos(yaw), uz = pz - ahead * std::cos(yaw) - right * std::sin(yaw);
                you = {.feet = {.x = ux, .y = static_cast<double>(generator.height(static_cast<std::int32_t>(std::floor(ux)), static_cast<std::int32_t>(std::floor(uz)))), .z = uz},
                       .eye_height = 1.62,
                       .sneaking = knob("YOU_SNEAK", 0) != 0};
            }
#endif
        }
        if (shot == "walk") {
            const double sx = knob("WALK_X", 60.5);
            const double sz = knob("WALK_Z", 40.5);
            const auto bx = static_cast<std::int32_t>(std::floor(sx));
            const auto bz = static_cast<std::int32_t>(std::floor(sz));
            walking = std::make_unique<vx::app::Walking>(
                vx::Vec3d{.x = sx, .y = static_cast<double>(generator.height(bx, bz)), .z = sz}, -64.0);
        }
    } else {
        std::cerr << "unknown shot " << shot << '\n';
        return 2;
    }

    const double fov = knob("FOV", 70.0) * std::numbers::pi / 180.0;
    std::size_t written = 0;
    for (int frame = 0; frame < to; ++frame) {
        const double t = frame / fps; // seconds into the shot
        const double u = frames > 1 ? static_cast<double>(frame) / (frames - 1) : 0.0;
        vx::render::Camera camera;
        camera.fov_y = static_cast<float>(fov);
        if (shot == "blocks") {
            // an N-cube of blocks put down one at a time, bottom layer first, over BUILD seconds
            const int n = static_cast<int>(knob("N", 4));
            const int all = n * n * n;
            const int placed = std::min(all, 1 + static_cast<int>(std::floor((all - 1) * smooth(t / knob("BUILD", 1.0)))));
            static std::array<vx::BlockState, vx::chunk_volume> dense{};
            static vx::PaletteScratch palette;
            dense.fill(vx::BlockState::air);
            const vx::BlockState block = *registry.find(std::getenv("BLOCK") ? std::getenv("BLOCK") : "core:stone");
            for (int i = 0; i < placed; ++i) {
                const int y = i / (n * n), z = (i / n) % n, x = i % n;
                dense[vx::local_index(x, y, z)] = block;
            }
            const vx::ChunkStorage storage = vx::ChunkStorage::from_dense(dense, palette);
            auto padded = std::make_unique<vx::PaddedChunk>();
            vx::assemble_padded(vx::ChunkNeighborhood(storage), *padded);
            vx::MeshScratch scratch;
            const vx::ChunkMesh mesh = vx::mesh_chunk(*padded, registry.visuals(), scratch, mesh_options());
            if (frame == 0 || placed == all) {
                std::cerr << "blocks: " << placed << " placed, " << mesh.all().size() << " quads\n";
            }
            if (!renderer.set_chunk({.x = 0, .y = 0, .z = 0}, mesh)) {
                return 1;
            }
        }
        if (shot == "chunk" && std::getenv("BUILD_LAYERS") != nullptr) {
            // the demo chunk built up a layer at a time: its 14 layers (y 0 to 13) over BUILD_LAYERS seconds
            const int layers = std::clamp(static_cast<int>(std::ceil(14.0 * smooth(t / knob("BUILD_LAYERS", 1.0)))), 1, 14);
            static std::array<vx::BlockState, vx::chunk_volume> dense{};
            static vx::PaletteScratch palette;
            dense = *demo_dense;
            for (int y = layers; y < vx::chunk_size; ++y) {
                for (int z = 0; z < vx::chunk_size; ++z) {
                    for (int x = 0; x < vx::chunk_size; ++x) {
                        dense[vx::local_index(x, y, z)] = vx::BlockState::air;
                    }
                }
            }
            const vx::ChunkStorage storage = vx::ChunkStorage::from_dense(dense, palette);
            auto padded = std::make_unique<vx::PaddedChunk>();
            vx::assemble_padded(vx::ChunkNeighborhood(storage), *padded);
            vx::MeshScratch scratch;
            if (!renderer.set_chunk({.x = 0, .y = 0, .z = 0}, vx::mesh_chunk(*padded, registry.visuals(), scratch, mesh_options()))) {
                return 1;
            }
        } else if (shot == "chunk" && std::getenv("MERGE_SWEEP") != nullptr) {
            // faces merge one direction at a time, the top first: each group's ranges come from the merged
            // mesh once its turn has come, from the quad-per-face mesh before
            constexpr std::array<std::size_t, 6> order = {2, 0, 4, 1, 5, 3}; // +y, +x, +z, -x, -z, -y
            const auto done = static_cast<std::size_t>(std::clamp(std::floor(7.0 * (t - knob("MERGE_FROM", 0.0)) / knob("MERGE_SWEEP", 1.0)), 0.0, 6.0));
            static std::vector<vx::Quad> quads;
            quads.clear();
            std::array<std::uint32_t, 12> counts{};
            for (std::size_t pass = 0; pass < 2; ++pass) {
                for (std::size_t face = 0; face < 6; ++face) {
                    const bool merged = std::find(order.begin(), order.begin() + static_cast<std::ptrdiff_t>(done), face) != order.begin() + static_cast<std::ptrdiff_t>(done);
                    const World::Stored& from_mesh = merged ? merged_mesh : faces_mesh;
                    std::size_t at = 0;
                    for (std::size_t k = 0; k < (pass * 6) + face; ++k) at += from_mesh.counts[k];
                    const std::uint32_t count = from_mesh.counts[(pass * 6) + face];
                    quads.insert(quads.end(), from_mesh.quads.begin() + static_cast<std::ptrdiff_t>(at),
                                 from_mesh.quads.begin() + static_cast<std::ptrdiff_t>(at + count));
                    counts[(pass * 6) + face] = count;
                }
            }
            vx::ChunkMesh mesh{};
            std::size_t at = 0;
            for (std::size_t pass = 0; pass < 2; ++pass) {
                for (std::size_t face = 0; face < 6; ++face) {
                    mesh.ranges[pass][face] = std::span<const vx::Quad>(quads.data() + at, counts[(pass * 6) + face]);
                    at += counts[(pass * 6) + face];
                }
            }
            if (frame == 0 || done == 6) {
                std::cerr << "merge sweep: " << done << " of 6 directions merged, " << quads.size() << " quads\n";
            }
            if (!renderer.set_chunk({.x = 0, .y = 0, .z = 0}, mesh)) {
                return 1;
            }
        }
        if (shot == "cube" || shot == "chunk" || shot == "blocks") {
            // an orbit around the middle, looking at it from above
            const bool cube = shot == "cube";
            const double half = knob("N", 4) / 2.0;
            const double cx = cube ? 0.5 : shot == "blocks" ? half : 16.0;
            const double cy = cube ? 0.5 : shot == "blocks" ? half : 8.5;
            const double cz = cube ? 0.5 : shot == "blocks" ? half : 16.0;
            double radius = knob("RADIUS", cube ? 3.4 : 56.0);
            if (std::getenv("DOLLY_FROM") != nullptr) {
                radius = knob("DOLLY_FROM", radius) + (radius - knob("DOLLY_FROM", radius)) * smooth(t / knob("DOLLY_TIME", 0.5));
            }
            const double tumble = knob("TUMBLE", 0.0);
            const double rise = knob("RISE", cube ? 1.5 : 30.0) * (1.0 + tumble * std::sin(t * 2.3)) * radius / knob("RADIUS", cube ? 3.4 : 56.0);
            camera.roll = static_cast<float>(tumble * 0.35 * std::sin(t * 1.9));
            // SPIN (radians a second) chains orbits across shots: the next starts at START + SPIN * its length
            const double phi = std::getenv("SPIN") != nullptr ? knob("START", 0.785) + knob("SPIN", 0.0) * t
                                                               : knob("START", 0.785) + knob("TURN", 0.25) * 2.0 * std::numbers::pi * u;
            camera.position = {cx + radius * std::sin(phi), cy + rise, cz + radius * std::cos(phi)};
            camera.yaw = static_cast<float>(phi);
            camera.pitch = static_cast<float>(-std::atan2(rise, radius));
        } else if (shot == "walk") {
            // the keys held each tick: sprinting forward, jumping while Space is held, as the game
            // repeats a held jump on landing; the yaw sways a little, the way a player looks around
            const double base = knob("WALK_YAW", -std::numbers::pi / 2);
            const auto yaw_at = [&](double seconds) { return walk_yaw(base, seconds); };
            const auto ticks_due = static_cast<std::uint64_t>(std::floor(t * 20.0)) + 1;
            while (walking->ticks() < ticks_due) {
                const double at = static_cast<double>(walking->ticks()) / 20.0;
                const vx::Player& was = walking->player();
                if (was.horizontal_collision && !was.minor_horizontal_collision) {
                    std::cerr << "walk: a step stopped the player at " << at << " s\n";
                }
                walking->tick(walk_input(walking->ticks(), yaw_at(at), was), *world);
            }
            const double between = t * 20.0 - std::floor(t * 20.0);
            const vx::app::WalkingFrame& now = walking->frame();
            const vx::Vec3d eye = now.eye_at(between);
            camera.position = {eye.x, eye.y, eye.z};
            camera.yaw = static_cast<float>(yaw_at(t));
            camera.pitch = static_cast<float>(knob("WALK_PITCH", -0.10));
            camera.fov_y = static_cast<float>(fov * now.fov_factor_at(between));
            camera = vx::app::bobbed(camera, now.bob_at(between, true));
        } else if (shot == "perdix-life") {
#ifdef SHOT_HAS_LIFE
            // his life's ticks (WARMUP seconds of them before the shot), the camera eased after him
            const double warm = knob("WARMUP", 0.0);
            const auto ticks_due = static_cast<std::uint64_t>(std::floor((t + warm) * 20.0)) + 1;
            while (figure.walking->ticks() < ticks_due) {
                const double at = static_cast<double>(figure.walking->ticks()) / 20.0 - warm;
                const bool staring = at >= knob("STARE_FROM", 1e9) && at < knob("STARE_FROM", 1e9) + knob("STARE_FOR", 2.5);
                life_tick(*life, *figure.walking, you, *world, life_scratch, head, staring && cam_started ? &last_camera : nullptr);
            }
            const vx::app::WalkingFrame& now = figure.walking->frame();
            figure.previous = now.previous_motion;
            figure.motion = now.motion;
            const double between = t * 20.0 - std::floor(t * 20.0);
            poses[0] = figure.pose(between, (t + warm) * 20.0, 0U);
            posed = 1;
            tagged = 1;
            tags[0] = {.anchor = vx::tag_anchor(poses[0].feet, poses[0].crouching), .text = "Perdix"};
            const vx::Vec3d feet = poses[0].feet;
            // the camera's place swings after his body's heading slowly (CAM_LAG seconds); its aim keeps
            // to his chest, a little ahead of him beside him, with a short lag of its own (AIM_LAG)
            const auto eased = [&](double lag) { return 1.0 - std::exp(-1.0 / (fps * std::max(0.02, lag))); };
            const double ease = eased(knob("CAM_LAG", 0.8)), aim_ease = eased(knob("AIM_LAG", 0.12));
            const vx::Vec3d chest = feet + vx::Vec3d{.x = 0.0, .y = 1.1, .z = 0.0};
            cam_heading += std::remainder(static_cast<double>(now.motion.body_yaw) - cam_heading, 2 * std::numbers::pi) * ease;
            const int cam = static_cast<int>(knob("CAM", 0));
            const double lead = cam == 0 ? knob("LEAD", 0.8) : 0.0;
            const vx::Vec3d aim_at = chest + vx::Vec3d{.x = -std::sin(cam_heading) * lead, .y = 0.0, .z = -std::cos(cam_heading) * lead};
            cam_aim = cam_started ? cam_aim + (aim_at - cam_aim) * aim_ease : aim_at;
            vx::Vec3d at_cam{};
            if (cam == 1) {
                at_cam = you.feet + vx::Vec3d{.x = 0.0, .y = you.eye_height, .z = 0.0};
            } else if (cam == 2) {
                const double phi = knob("START", 0.785) + knob("SPIN", 0.15) * t, radius = knob("RADIUS", 9.0);
                at_cam = cam_aim + vx::Vec3d{.x = radius * std::sin(phi), .y = knob("RISE", 9.0), .z = radius * std::cos(phi)};
            } else {
                const double fx = -std::sin(cam_heading), fz = -std::cos(cam_heading), rx = std::cos(cam_heading), rz = -std::sin(cam_heading);
                const double side = knob("SIDE", 4.5), back = knob("BACK", 1.5), up = knob("UP", 1.4);
                at_cam = {.x = feet.x + rx * side - fx * back, .y = feet.y + up, .z = feet.z + rz * side - fz * back};
            }
            camera.position = {at_cam.x, at_cam.y, at_cam.z};
            look_along(camera, cam_aim.x - at_cam.x, cam_aim.y - at_cam.y, cam_aim.z - at_cam.z);
            last_camera = at_cam;
            cam_started = true;
#endif
        } else if (shot.starts_with("perdix-")) {
            // Perdix's ticks: standing (born) or walking ahead (walk, stuck); he looks where he
            // walks, and in born turns his head toward LOOK_YAW from LOOK_AT seconds
            const auto yaw = static_cast<float>(knob("PERDIX_YAW", 0.0));
            const bool born = shot == "perdix-born";
            const auto ticks_due = static_cast<std::uint64_t>(std::floor(t * 20.0)) + 1;
            while (figure.walking->ticks() < ticks_due) {
                const double at = static_cast<double>(figure.walking->ticks()) / 20.0;
                vx::TickInput input;
                input.yaw = yaw;
                if (!born) {
                    input.held.forward = at >= knob("WALK_FROM", 0.0);
                    input.held.sprint = at >= knob("SPRINT_FROM", 1e9);
                    input.held.jump = at >= knob("JUMP_FROM", 1e9);
                }
                // the head turns as a mob's look control turns it: 10 degrees a tick at most
                float look = yaw;
                if (born && at >= knob("LOOK_AT", 1e9)) {
                    const double want = knob("LOOK_YAW", static_cast<double>(yaw) + 0.6);
                    const double steps = (at - knob("LOOK_AT", 0.0)) * 20.0 + 1.0;
                    look = static_cast<float>(static_cast<double>(yaw) +
                                              std::clamp(want - static_cast<double>(yaw), -steps * 0.1745, steps * 0.1745));
                }
                figure.tick(input, *world, look, static_cast<float>(born ? knob("LOOK_PITCH", 0.0) : 0.0));
            }
            const double between = t * 20.0 - std::floor(t * 20.0);
            const bool skinned = t >= knob("SKIN_AT", 0.0);
            poses[0] = figure.pose(between, t * 20.0, skinned ? 0U : 99U); // 99: not given, magenta
            if (knob("DEBUG_POSE", 0) != 0 && frame % 10 == 0) {
                std::cerr << "t " << t << " feet " << poses[0].feet.x << "," << poses[0].feet.y << "," << poses[0].feet.z
                          << " body " << poses[0].body_yaw << " head " << poses[0].head_yaw << " limb " << poses[0].limb_position
                          << " amount " << poses[0].limb_amount << '\n';
            }
            posed = 1;
            tagged = t >= knob("TAG_AT", 0.0) ? 1 : 0;
            tags[0] = {.anchor = vx::tag_anchor(poses[0].feet, poses[0].crouching), .text = "Perdix"};
            const vx::Vec3d feet = poses[0].feet;
            const double heading = static_cast<double>(yaw);
            const double fx = -std::sin(heading), fz = -std::cos(heading); // his forward
            const double rx = std::cos(heading), rz = -std::sin(heading);  // his right
            if (born) {
                // in front of him, pushing in from a wide view of the hill to his face over PUSH
                // seconds; AROUND swings the camera toward his left (radians)
                const double k = smooth(t / knob("PUSH", 6.0));
                const double dist = knob("FAR", 12.0) + (knob("NEAR", 1.4) - knob("FAR", 12.0)) * k;
                const double rise = knob("FAR_UP", 5.0) + (knob("NEAR_UP", 1.64) - knob("FAR_UP", 5.0)) * k;
                const double around = knob("AROUND", 0.0);
                const double ox = fx * std::cos(around) - rx * std::sin(around);
                const double oz = fz * std::cos(around) - rz * std::sin(around);
                const double cx = feet.x + ox * dist, cz = feet.z + oz * dist;
                const double aim = knob("AIM_FAR", 1.0) + (knob("AIM_NEAR", 1.64) - knob("AIM_FAR", 1.0)) * k;
                camera.position = {cx, feet.y + rise, cz};
                look_along(camera, feet.x - cx, aim - rise, feet.z - cz);
            } else {
                // beside him on his right, a little behind and above, looking just ahead of him
                const double side = knob("SIDE", 4.5), back = knob("BACK", 1.5), up = knob("UP", 1.4);
                const double cx = feet.x + rx * side - fx * back;
                const double cz = feet.z + rz * side - fz * back;
                const double lead = knob("LEAD", 0.8);
                camera.position = {cx, feet.y + up, cz};
                look_along(camera, feet.x + fx * lead - cx, 1.0 - up, feet.z + fz * lead - cz);
            }
        } else if (shot == "stream") {
            const double grow = knob("GROW", 1.6);  // seconds for the view distance to fill
            const double vmax = knob("SPEED", 70.0); // blocks a second, once flying
            const double ramp = smooth((t - grow) / 1.2);
            sx += (knob("DRIFT", 6.0) + vmax * ramp) / fps;
            sz = knob("Z0", 40.0) + knob("SWING", 18.0) * std::sin(t * 0.55);
            // the view distance spreads out from GROW_FROM blocks (the ground in view at once) to VIEW chunks
            const double from_r = knob("GROW_FROM", 96.0) / (knob("VIEW", 8.0) * 32.0);
            const double radius = knob("VIEW", 8.0) * 32.0 * (t < grow ? from_r + (1.0 - from_r) * smooth(t / grow) : 1.0);
            stream->want(sx, sz, radius, knob("VIEW", 8.0) * 32.0 + 64.0, static_cast<std::size_t>(knob("PER_FRAME", 40)));
            camera.position = {sx, knob("Y0", 120.0) + knob("RISE", 25.0) * smooth(t / 8.0), sz};
            camera.yaw = static_cast<float>(-std::numbers::pi / 2 + 0.06 * std::sin(t * 0.55));
            camera.pitch = static_cast<float>(knob("PITCH", -0.36));
        } else if (shot == "horizon-lod") {
            // a still camera turning: the levels were made for where it stands
            camera.position = {knob("X0", 0.5), knob("Y0", 300.0), knob("Z0", 0.5)};
            camera.yaw = static_cast<float>(knob("YAW", 0.0) + (knob("TURN", 0.05) * t));
            camera.pitch = static_cast<float>(knob("PITCH", -0.3));
        } else if (shot == "horizon") {
            // the view distance from START to VIEW chunks, the camera rising and tipping down with it
            const double near_r = knob("START", 16.0) * 32.0, far_r = knob("VIEW", 64.0) * 32.0;
            const double g = smooth((t - knob("GROW_AT", 1.5)) / std::max(knob("GROW", 3.0), 0.01));
            const double x = knob("X0", 0.0), z = knob("Z0", 0.0);
            stream->want(x, z, near_r + (far_r - near_r) * g, far_r + 64.0,
                         static_cast<std::size_t>(knob("PER_FRAME", 4000)));
            camera.position = {x, knob("Y0", 140.0) + knob("RISE", 900.0) * g, z};
            camera.yaw = static_cast<float>(knob("YAW", 0.0) + knob("TURN", 0.05) * t);
            camera.pitch = static_cast<float>(knob("PITCH0", -0.12) + (knob("PITCH1", -0.55) - knob("PITCH0", -0.12)) * g);
        } else {
            // a cubic Bezier through four points, looking ahead along it and a little down
            const auto point = [&](const char* name, double x, double y, double z) {
                const std::string n = name;
                return std::array<double, 3>{knob((n + "X").c_str(), x), knob((n + "Y").c_str(), y),
                                             knob((n + "Z").c_str(), z)};
            };
            const double shift = knob("SHIFT_X", 0.0);
            auto a = point("A", -40, 92, 52);
            auto b = point("B", 70, 100, 50);
            auto c = point("C", 250, 175, 70);
            auto d = point("D", 430, 215, 80);
            for (auto* p : {&a, &b, &c, &d}) {
                (*p)[0] += std::lround(shift / 32.0) * 32.0;
            }
            const double s = smooth(knob("EASE", 0) != 0 ? u : u * 0.15 + smooth(u) * 0.85);
            const auto bezier = [&](double v, int i) {
                const double w = 1.0 - v;
                return w * w * w * a[i] + 3 * w * w * v * b[i] + 3 * w * v * v * c[i] + v * v * v * d[i];
            };
            camera.position = {bezier(s, 0), bezier(s, 1), bezier(s, 2)};
            const double ahead = std::min(1.0, s + 0.02);
            const double back = ahead - 0.02;
            look_along(camera, bezier(ahead, 0) - bezier(back, 0), 0.0, bezier(ahead, 2) - bezier(back, 2));
            camera.pitch = static_cast<float>(knob("PITCH0", -0.30) + (knob("PITCH1", -0.16) - knob("PITCH0", -0.30)) * smooth(u));
            camera.roll = static_cast<float>(knob("ROLL", 0.06) * std::sin(u * std::numbers::pi));
            camera.yaw += static_cast<float>(knob("YAW_OFFSET", 0.0)); // positive turns left
        }
        if (frame < from && !stream) {
            continue;
        }
        if (!renderer.render({.sky = sky, .camera = camera, .cubes = cubes, .players = std::span(poses).first(posed), .tags = std::span(tags).first(tagged), .overlay = nullptr, .chunk_changes = stream ? static_cast<vx::render::ChunkChanges*>(stream.get()) : pending.get()})) {
            std::cerr << "render failed at frame " << frame << '\n';
            return 1;
        }
        if (frame < from) {
            continue;
        }
        const vx::Result<std::vector<std::uint8_t>> pixels = renderer.capture();
        if (!pixels) {
            std::cerr << pixels.error().message << '\n';
            return 1;
        }
        std::fwrite(pixels.value().data(), 1, pixels.value().size(), stdout);
        ++written;
    }
    std::fflush(stdout);
    const auto counts = renderer.context().instance().validation_counts();
    std::cerr << shot << ": " << written << " frames, validation errors " << counts.errors << ", warnings "
              << counts.warnings << '\n';
    return counts.errors == 0 ? 0 : 3;
}
