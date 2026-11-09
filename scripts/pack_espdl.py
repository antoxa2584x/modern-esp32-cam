# Packs esp-dl .espdl models into one PDL3 package, the format esp-dl 3.3's
# fbs loader reads from flash (what the components' CMake does with esp-dl's
# fbs_loader/pack_espdl_models.py). Used once to make lib/human_face/models:
#   python scripts/pack_espdl.py OUT.espdl MODEL.espdl [MODEL.espdl ...]
import hashlib
import struct
import sys
from pathlib import Path

HEADER = 60  # magic[4] version[16] size(u32) sha256[32] count(u32)


def pack(out, models, version="v1.0"):
    names, blobs = [], []
    for m in map(Path, models):
        data = m.read_bytes()
        if data[:4] != b"EDL2":
            raise SystemExit(f"{m}: not an EDL2 model")
        data += b"\0" * (-len(data) % 16)  # each model 16-byte aligned
        names.append(m.name.encode())
        blobs.append(data)

    name_off = HEADER + 12 * len(names)
    data_off = (name_off + sum(map(len, names)) + 15) & ~15
    entries, n_off, d_off = b"", name_off, data_off
    for n, b in zip(names, blobs):
        entries += struct.pack("<III", d_off, n_off, len(n))
        n_off += len(n)
        d_off += len(b)
    size = d_off

    head = b"PDL3" + version.encode().ljust(16, b"\0") + struct.pack("<I", size)
    head += b"\0" * 32 + struct.pack("<I", len(names))
    pkg = bytearray(head + entries + b"".join(names))
    pkg += b"\0" * (data_off - len(pkg)) + b"".join(blobs)
    assert len(pkg) == size
    # SHA-256 of the whole package with the digest field zeroed
    pkg[24:56] = hashlib.sha256(bytes(pkg)).digest()
    Path(out).write_bytes(pkg)
    print(f"{out}: {len(names)} models, {size} bytes")


if __name__ == "__main__":
    pack(sys.argv[1], sys.argv[2:])
