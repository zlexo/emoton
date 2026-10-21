"""
Adds a `duration` output to the Kokoro ONNX model, so kokoro-onnx can say when
every phoneme is spoken (Kokoro.has_timings, Kokoro.create_timed).

Kokoro's duration predictor scores 50 sigmoid bins per token, sums them,
divides by the speed, rounds and clamps to at least one frame. Cast to int64
and with the batch axis dropped, that vector is what the length regulator
expands (a CumSum that builds the token-to-frame alignment): one entry per
input token, both pad tokens included, in decoder frames of 600 samples.
kokoro-onnx wants exactly that: sliding.token_edges turns the running sum into
sample offsets, scaled to the audio length.

The vector is found by that structure, not by node name, and exposed through
an Identity node. Nothing that computes the audio changes, and the check at the
end proves the audio bit-identical on five sentences.

The `onnx` package is not needed. The few message types this touches are
declared below with onnx.proto's field numbers; every field they leave out
(weights, attribute tensors, metadata, ...) is kept as unknown bytes and
written back unchanged.

    python expose_durations.py                  # models/kokoro-v1.0.int8.onnx -> .timed.onnx, then check
    python expose_durations.py IN OUT [--no-check]
"""
import argparse, os, sys

from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "models", "kokoro-v1.0.int8.onnx")
TARGET = os.path.join(HERE, "models", "kokoro-v1.0.int8.timed.onnx")
OUTPUT = "duration"
INT64 = 7  # TensorProto.DataType.INT64
SAMPLE_RATE = 24000

# The subset of onnx.proto read or written here: (field, number, type), a
# trailing * for repeated. Field numbers must match onnx.proto exactly.
SCHEMA = {
    "ModelProto": [("graph", 7, "GraphProto")],
    "GraphProto": [("node", 1, "NodeProto*"), ("input", 11, "ValueInfoProto*"), ("output", 12, "ValueInfoProto*")],
    "NodeProto": [("input", 1, "string*"), ("output", 2, "string*"), ("name", 3, "string"),
                  ("op_type", 4, "string"), ("attribute", 5, "AttributeProto*")],
    "AttributeProto": [("name", 1, "string"), ("i", 3, "int64")],
    "ValueInfoProto": [("name", 1, "string"), ("type", 2, "TypeProto")],
    "TypeProto": [("tensor_type", 1, "TensorTypeProto")],
    "TensorTypeProto": [("elem_type", 1, "int32"), ("shape", 2, "TensorShapeProto")],
    "TensorShapeProto": [("dim", 1, "DimensionProto*")],
    "DimensionProto": [("dim_value", 1, "int64"), ("dim_param", 2, "string")],
}


def model_type():
    """The ModelProto class for SCHEMA, built at runtime (proto2, so presence survives)."""
    F = descriptor_pb2.FieldDescriptorProto
    scalars = {"string": F.TYPE_STRING, "int64": F.TYPE_INT64, "int32": F.TYPE_INT32}
    file = descriptor_pb2.FileDescriptorProto(name="onnx_subset.proto", package="onnx_subset", syntax="proto2")
    for message, fields in SCHEMA.items():
        m = file.message_type.add(name=message)
        for name, number, kind in fields:
            label = F.LABEL_REPEATED if kind.endswith("*") else F.LABEL_OPTIONAL
            f = m.field.add(name=name, number=number, label=label)
            kind = kind.rstrip("*")
            if kind in scalars:
                f.type = scalars[kind]
            else:
                f.type, f.type_name = F.TYPE_MESSAGE, f".onnx_subset.{kind}"
    pool = descriptor_pool.DescriptorPool()
    pool.Add(file)
    return message_factory.GetMessageClass(pool.FindMessageTypeByName("onnx_subset.ModelProto"))


def find_durations(graph):
    """The tensor the length regulator expands, and the ops that lead to it.

    Sigmoid -> ReduceSum -> Div(speed) -> Round -> Clip(min 1) -> Cast(int64),
    then the batch axis dropped (Gather or Squeeze) right before the CumSum.
    """
    producer = {out: node for node in graph.node for out in node.output}
    consumers = {}
    for node in graph.node:
        for name in node.input:
            consumers.setdefault(name, []).append(node)

    def made_by(name, op):
        node = producer.get(name)
        return node if node is not None and node.op_type == op else None

    def predicted(node):
        div = made_by(node.input[0], "Div")
        total = div and made_by(div.input[0], "ReduceSum")
        return bool(total and made_by(total.input[0], "Sigmoid"))

    rounds = [n for n in graph.node if n.op_type == "Round" and predicted(n)]
    if len(rounds) != 1:
        raise SystemExit(f"expected one Sigmoid -> ReduceSum -> Div -> Round chain (the duration predictor), found {len(rounds)}")
    steps, tensor = ["Sigmoid", "ReduceSum", "Div", "Round"], rounds[0].output[0]

    def only_user(name):
        users = consumers.get(name, [])
        if len(users) != 1:
            raise SystemExit(f"{name} feeds {len(users)} nodes, expected one: not an export this script knows")
        return users[0]

    for op in ("Clip", "Cast"):
        node = only_user(tensor)
        if node.op_type != op:
            raise SystemExit(f"after {steps[-1]} came {node.op_type}, expected {op}")
        steps.append(op)
        tensor = node.output[0]
    if next((a.i for a in producer[tensor].attribute if a.name == "to"), None) != INT64:
        raise SystemExit("the rounded durations are not cast to int64")

    node = only_user(tensor)
    while node.op_type in ("Gather", "Squeeze"):
        steps.append(node.op_type)
        tensor = node.output[0]
        node = only_user(tensor)
    if node.op_type != "CumSum":
        raise SystemExit(f"the durations feed {node.op_type}, expected the length regulator's CumSum")
    return tensor, steps + ["CumSum"]


def token_axis(graph):
    """Name of the token input's length axis; the durations share it (pads included)."""
    for value in graph.input:
        dims = value.type.tensor_type.shape.dim
        if value.name in ("tokens", "input_ids") and len(dims) == 2 and dims[1].dim_param:
            return dims[1].dim_param
    return "tokens"


def expose(source, target):
    data = open(source, "rb").read()
    model = model_type().FromString(data)
    # Same size after a round trip means no field was dropped (unknown ones included)
    if len(model.SerializeToString()) != len(data):
        raise SystemExit("re-encoding the model changed its size, refusing to write")
    graph = model.graph
    if any(o.name == OUTPUT for o in graph.output):
        raise SystemExit(f"{source} already has a {OUTPUT!r} output")

    tensor, steps = find_durations(graph)
    graph.node.add(name=f"/{OUTPUT}/Identity", op_type="Identity", input=[tensor], output=[OUTPUT])
    out = graph.output.add(name=OUTPUT)
    out.type.tensor_type.elem_type = INT64
    out.type.tensor_type.shape.dim.add(dim_param=token_axis(graph))

    part = target + ".part"
    with open(part, "wb") as f:
        f.write(model.SerializeToString())
    os.replace(part, target)
    print(f"{OUTPUT} = {tensor} ({' -> '.join(steps)}), int64 frames per token, pads included")
    print(f"wrote {target}")


SENTENCES = [
    "Last time, I built a chunk out of two hundred and seventy-five faces.",
    "Is that legal? Well, it only reads them out of your own copy, every time it starts.",
    "So now, I'm gonna yoink the real ones.",
    "Eleven textures, sixteen by sixteen pixels: 64 colours to pick from!",
    "Here's the thing; it's a well-known trick, and it's twice as fast.",
]


def check(source, target, voice="am_fenrir", speed=1.08):
    """Same audio from both models, and durations that add up to it. True when all hold."""
    import numpy as np
    from kokoro_onnx import Kokoro

    voices = os.path.join(os.path.dirname(source), "voices-v1.0.bin")
    plain, timed = Kokoro(source, voices), Kokoro(target, voices)
    out = timed.sess.get_outputs()[1]
    ok = timed.has_timings and not plain.has_timings and out.name == OUTPUT and out.type == "tensor(int64)"
    print(f"has_timings: original {plain.has_timings}, timed {timed.has_timings}; output {out.name} {out.type} {out.shape}")
    style = plain.voices[voice]
    changed_by_pauses = 0
    for text in SENTENCES:
        ids = plain.tokenizer.tokenize(plain.tokenizer.phonemize(text, "en-us"))
        feed = {"tokens": np.array([[0, *ids, 0]], np.int64), "style": style[len(ids) - 1],
                "speed": np.array([speed], np.float32)}
        (a,) = plain.sess.run(None, feed)
        b, frames = timed.sess.run(None, feed)
        same_raw = np.array_equal(a, b)
        hop = len(b) / frames.sum()

        # What speak.py gets: the old create() against create_timed() without kokoro's own pause splicing
        old, _ = plain.create(text, voice=voice, speed=speed)
        new, _, spans = timed.create_timed(text, voice=voice, speed=speed, sentence_pause=0.0, clause_pause=0.0)
        same = np.array_equal(old, new)
        spliced, _, _ = timed.create_timed(text, voice=voice, speed=speed)
        changed_by_pauses += not np.array_equal(old, spliced)

        # Untrimmed timings against the raw audio: contiguous, and with the two pads they cover it
        _, _, raw = timed.create_timed(text, voice=voice, speed=speed, trim=False, sentence_pause=0.0, clause_pause=0.0)
        starts = np.array([t.start for t in raw])
        ends = np.array([t.end for t in raw])
        contiguous = bool(np.all(ends >= starts) and np.allclose(starts[1:], ends[:-1]))
        pads = (frames[0] + frames[-1]) * hop / SAMPLE_RATE
        gap = abs((ends - starts).sum() + pads - len(b) / SAMPLE_RATE)
        frame = hop / SAMPLE_RATE
        inside = 0 <= spans[0].start and spans[-1].end <= len(new) / SAMPLE_RATE + 1e-9

        good = (same_raw and same and hop == int(hop) and len(frames) == len(ids) + 2 and len(raw) == len(ids)
                and contiguous and gap <= frame and inside)
        ok &= good
        print(f"{'ok  ' if good else 'FAIL'} raw audio identical {same_raw}, create() vs create_timed() identical {same} "
              f"({len(new)} samples); {len(ids)} phonemes, {len(frames)} durations, {hop:g} samples/frame; "
              f"timings contiguous {contiguous}, cover the audio within {gap * 1000:.3f} ms; {text!r}")
    # Control: with its default pauses create_timed splices silence after marks, so the
    # comparison above can fail, and speak.py turns those pauses off
    print(f"control: create_timed with default pauses changed the audio of {changed_by_pauses} of {len(SENTENCES)} sentences")
    return bool(ok and changed_by_pauses > 0)


def main():
    ap = argparse.ArgumentParser(description="Add a duration output to the Kokoro ONNX model.")
    ap.add_argument("source", nargs="?", default=SOURCE)
    ap.add_argument("target", nargs="?", default=TARGET)
    ap.add_argument("--no-check", action="store_true", help="skip the audio comparison")
    args = ap.parse_args()
    expose(args.source, args.target)
    return 0 if args.no_check or check(args.source, args.target) else 1


if __name__ == "__main__":
    code = main()
    # onnxruntime can abort during interpreter teardown on macOS; the work is done
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)
