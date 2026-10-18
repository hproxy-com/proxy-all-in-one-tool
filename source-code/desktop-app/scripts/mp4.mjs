// mp4.mjs: one H.264 track in an MP4 file, from the samples WebCodecs gives back
// (marketing-video.mjs). No dependencies: an MP4 is a tree of boxes, each a 32-bit size,
// a four-letter type and its contents, big-endian.
//
// The layout is the one every browser plays, Safari included:
//   ftyp                      the brands
//   moov                      the description, BEFORE the data, so playback starts at once
//     mvhd                    timescale and length
//     trak
//       tkhd                  the track, its size on screen
//       edts/elst             play it from its start
//       mdia/mdhd, hdlr       its own timescale, "this is video"
//       mdia/minf/stbl        where every frame is:
//         stsd/avc1/avcC      the decoder's setup (WebCodecs' decoderConfig.description)
//         stsd/avc1/colr      the colours: BT.709, video range, the way the frames were made
//         stts                how long each frame shows
//         stss                which frames are keyframes
//         stsc, stsz, stco    all frames in one run: their sizes, and where the run starts
//   mdat                      the frames themselves
// Frames must come in display order with no reordering (no B-frames): the encoder is set for it.

const u8 = (n) => Buffer.from([n & 255]);
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const box = (type, ...parts) => {
  const body = Buffer.concat(parts.flat());
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, "latin1"), body]);
};
const full = (type, version, flags, ...parts) => box(type, Buffer.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32);

/**
 * @param {{ width: number, height: number, timescale: number, description: Buffer,
 *           samples: { data: Buffer, duration: number, key: boolean }[] }} track
 *        duration in timescale units; description = the avcC record.
 */
export function mp4({ width, height, timescale, description, samples }) {
  if (!samples.length || !samples[0].key) throw new Error("the first frame must be a keyframe");
  const duration = samples.reduce((sum, s) => sum + s.duration, 0);
  const ftyp = box("ftyp", Buffer.from("isom", "latin1"), u32(0x200), Buffer.from("isomiso2avc1mp41", "latin1"));

  const moov = (dataAt) => {
    const runs = [];
    for (const s of samples) {
      const last = runs[runs.length - 1];
      if (last && last[1] === s.duration) last[0]++;
      else runs.push([1, s.duration]);
    }
    const keys = samples.flatMap((s, i) => (s.key ? [i + 1] : []));
    const avc1 = box(
      "avc1",
      Buffer.alloc(6), u16(1), // reserved, data reference 1
      Buffer.alloc(16), // pre-defined and reserved
      u16(width), u16(height),
      u32(0x00480000), u32(0x00480000), // 72 dpi
      u32(0), u16(1), // reserved, one frame per sample
      Buffer.alloc(32), // no compressor name
      u16(0x0018), u16(0xffff), // depth 24, pre-defined -1
      box("avcC", description),
      box("colr", Buffer.from("nclx", "latin1"), u16(1), u16(1), u16(1), u8(0)),
    );
    const stbl = box(
      "stbl",
      full("stsd", 0, 0, u32(1), avc1),
      full("stts", 0, 0, u32(runs.length), ...runs.map(([count, delta]) => [u32(count), u32(delta)])),
      full("stss", 0, 0, u32(keys.length), ...keys.map(u32)),
      full("stsc", 0, 0, u32(1), u32(1), u32(samples.length), u32(1)),
      full("stsz", 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.data.length))),
      full("stco", 0, 0, u32(1), u32(dataAt)),
    );
    const minf = box("minf", full("vmhd", 0, 1, Buffer.alloc(8)), box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))), stbl);
    const mdia = box(
      "mdia",
      full("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0)), // language "und"
      full("hdlr", 0, 0, u32(0), Buffer.from("vide", "latin1"), Buffer.alloc(12), Buffer.from("VideoHandler\0", "latin1")),
      minf,
    );
    const tkhd = full("tkhd", 0, 3, u32(0), u32(0), u32(1), u32(0), u32(duration), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), ...MATRIX, u32(width * 65536), u32(height * 65536));
    const edts = box("edts", full("elst", 0, 0, u32(1), u32(duration), u32(0), u16(1), u16(0)));
    const mvhd = full("mvhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u32(0x00010000), u16(0x0100), Buffer.alloc(10), ...MATRIX, Buffer.alloc(24), u32(2));
    return box("moov", mvhd, box("trak", tkhd, edts, mdia));
  };

  // The data starts after ftyp, moov and the mdat header; moov's size does not depend on that offset.
  const head = moov(0).length;
  const data = Buffer.concat(samples.map((s) => s.data));
  return Buffer.concat([ftyp, moov(ftyp.length + head + 8), u32(8 + data.length), Buffer.from("mdat", "latin1"), data]);
}
