/**
 * CLI Test Runner for the v4-ir-to-raster Compiler
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { compileCadIrToRaster, type ImageFormat, type RasterRenderOptions } from './index.js';
import { type SvgPreset } from '@lavinci/v4-ir-to-svg';

const ALL_PRESETS: SvgPreset[] = [
  'web-cad-interactive',
  'print-document',
  'fabrication-laser-cnc',
  'facility-bim-indoor',
  'patent-technical-lineart',
  'thumbnail-preview',
];

const ALL_FORMATS: ImageFormat[] = ['png', 'jpeg', 'webp', 'tiff', 'bmp'];

async function main() {
  const args = process.argv.slice(2);
  const inputFile = args.find(a => !a.startsWith('--'));
  const presetArg = args.includes('--preset') ? (args[args.indexOf('--preset') + 1] as SvgPreset) : undefined;
  const renderAll = args.includes('--all');

  if (!inputFile) {
    console.error('Usage: npx tsx src/testRasterRunner.ts <path-to-semantic-ir-json> [--preset <preset>] [--all]');
    process.exit(1);
  }

  const resolvedInput = path.resolve(inputFile);
  console.log(`\n===============================================================`);
  console.log(`🖼️  LA VINCI — v4-ir-to-raster COMPILER TEST RUNNER`);
  console.log(`===============================================================`);
  console.log(`Input: ${resolvedInput}`);

  if (!resolvedInput.endsWith('.json')) {
    console.error(`\n❌ Error: v4-ir-to-raster takes a Semantic CAD IR (.json) file as input.`);
    process.exit(1);
  }

  console.log(`Loading Semantic CAD IR JSON...`);
  const rawContent = await fs.readFile(resolvedInput, 'utf8');
  const parsed = JSON.parse(rawContent);

  // Reconstruct Maps
  if (parsed.symbols?.layers && !(parsed.symbols.layers instanceof Map)) {
    parsed.symbols.layers = new Map(Object.entries(parsed.symbols.layers));
  }
  if (parsed.symbols?.linetypes && !(parsed.symbols.linetypes instanceof Map)) {
    parsed.symbols.linetypes = new Map(Object.entries(parsed.symbols.linetypes));
  }
  if (parsed.symbols?.textStyles && !(parsed.symbols.textStyles instanceof Map)) {
    parsed.symbols.textStyles = new Map(Object.entries(parsed.symbols.textStyles));
  }
  if (parsed.blockDefinitions && !(parsed.blockDefinitions instanceof Map)) {
    parsed.blockDefinitions = new Map(Object.entries(parsed.blockDefinitions));
  }

  const presetsToRun: SvgPreset[] = renderAll 
    ? ALL_PRESETS 
    : [presetArg ?? 'web-cad-interactive'];

  const formatsToRun: ImageFormat[] = renderAll ? ALL_FORMATS : ['png'];

  const baseName = path.basename(resolvedInput).replace(/(_semantic_ir)?\.(dwg|json)$/i, '');

  console.log(`\nCompiling Raster images...`);

  for (const p of presetsToRun) {
    for (const format of formatsToRun) {
      const opts: RasterRenderOptions = {
        preset: p,
        format,
        quality: 85,
        resolutionMultiplier: format === 'png' ? 2.0 : 1.0 // Render high-res PNG for fun
      };

      try {
        const result = await compileCadIrToRaster(parsed, opts);
        
        const outFilename = `${baseName}_${p}.${format}`;
        const outPath = path.join(process.cwd(), outFilename);
        await fs.writeFile(outPath, result.buffer);

        const stat = await fs.stat(outPath);
        const sizeKb = (stat.size / 1024).toFixed(1);

        console.log(`  ✓ [${p.padEnd(24)} | ${format.padEnd(4)}] -> ${outFilename.padEnd(40)} (${sizeKb.padStart(6)} KB, ${result.timeMs.toFixed(1)} ms, ${result.width}x${result.height})`);
      } catch (err) {
        console.error(`  ❌ Failed [${p} | ${format}]:`, err);
      }
    }
  }

  console.log(`===============================================================\n`);
}

main().catch(err => {
  console.error('\n❌ Fatal error during Raster compilation:', err);
  process.exit(1);
});
