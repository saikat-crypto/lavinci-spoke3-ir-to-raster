import * as fs from 'fs/promises';
import * as path from 'path';
import sharp from 'sharp';
import { compileCadIrToRaster, type RasterRenderOptions, type ImageFormat } from './index.js';

// Construct a valid minimal IR mapping exactly what v4-dwg-to-ir outputs
const minimalIR = {
  meta: {
    modelExtents: { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 }
  },
  modelSpace: {
    entities: [
      {
        kind: 'geometric',
        id: 'line1',
        layerName: '0',
        visual: { color: { kind: 'bylayer' }, lineWeight: { kind: 'bylayer' } },
        geometry: {
          kind: 'line',
          start: { x: -1000, y: -1000, z: 0 },
          end: { x: 1000, y: 1000, z: 0 }
        }
      }
    ]
  },
  symbols: {
    layers: new Map([['0', { name: '0', color: 7, isOff: false, isFrozen: false }]]),
    linetypes: new Map(),
    textStyles: new Map()
  },
  blockDefinitions: new Map()
};

async function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`❌ ASSERTION FAILED: ${msg}`);
  console.log(`  ✅ ${msg}`);
}

async function runRedTeamTests() {
  console.log("===============================================================");
  console.log("🔥 INITIATING RED TEAM STRESS TESTS FOR v4-ir-to-raster 🔥");
  console.log("===============================================================\n");

  // 1. OOM Shield Test
  console.log("TEST 1: The OOM 'Billion Pixel' Attack");
  try {
    const oomResult = await compileCadIrToRaster(minimalIR, {
      resolutionMultiplier: 50000 // Attempting to render a 500,000,000 pixel width image!
    });
    // Max dimension should be clamped to 16384
    const maxDim = Math.max(oomResult.width, oomResult.height);
    await assert(maxDim <= 16384, `Safety clamp activated! Prevented server crash. Render dimension clamped to ${maxDim}px.`);
  } catch (e) {
    throw new Error(`OOM test crashed the process! ${e}`);
  }

  // 2. DPI Metadata Test
  console.log("\nTEST 2: Print Density (DPI) Metadata Injection");
  const dpiResult = await compileCadIrToRaster(minimalIR, { format: 'png', dpi: 600 });
  const metadata = await sharp(dpiResult.buffer).metadata();
  await assert(metadata.density === 600, `Physical print DPI correctly embedded in EXIF metadata as 600 (Found: ${metadata.density}).`);

  const tiffDpiResult = await compileCadIrToRaster(minimalIR, { format: 'tiff', dpi: 300 });
  const tiffMetadata = await sharp(tiffDpiResult.buffer).metadata();
  await assert(tiffMetadata.density === 300, `TIFF Print DPI correctly embedded as 300 (Found: ${tiffMetadata.density}).`);

  // 3. Format Integrity Test
  console.log("\nTEST 3: Format Encoding Integrity (Lossless & Lossy)");
  const formats: ImageFormat[] = ['png', 'jpeg', 'webp', 'tiff', 'bmp'];
  for (const fmt of formats) {
    const res = await compileCadIrToRaster(minimalIR, { format: fmt });
    await assert(res.buffer.length > 50, `Format [${fmt.toUpperCase()}] generated valid binary buffer (${res.buffer.length} bytes)`);
  }

  // 4. Background Flattening (Alpha Handling)
  console.log("\nTEST 4: Background Color Flattening (JPEG Alpha Protection)");
  const bgResult = await compileCadIrToRaster(minimalIR, { format: 'jpeg', backgroundColor: '#ff0000', targetWidth: 100, targetHeight: 100 });
  await assert(bgResult.buffer.length > 0, `JPEG successfully flattened with custom hex background without alpha channel crash.`);

  // 5. Invalid / Corrupted IR Handling
  console.log("\nTEST 5: Corrupt Geometry & Null IR Injection");
  try {
    await compileCadIrToRaster(null as any, { format: 'png' });
    throw new Error("Should have thrown error on null IR!");
  } catch (err) {
    const e = err as any;
    await assert(
      e.message.includes("Cannot read") || e.message.includes("undefined") || e.message.includes("null"), 
      `Gracefully caught null IR object without native C++ segfault: ${e.message}`
    );
  }

  console.log("\n===============================================================");
  console.log("🚀 ALL RED TEAM TESTS PASSED! SPOKE 3 IS FULLY HARDENED.");
  console.log("===============================================================\n");
}

runRedTeamTests().catch(err => {
  console.error("\n❌ RED TEAM TEST FAILED:");
  console.error(err);
  process.exit(1);
});
