/**
 * v4-ir-to-raster: High-Fidelity CAD IR to Raster (PNG/JPEG/WEBP) Compiler
 * 
 * Leverages the pure-math SVG compiler (v4-ir-to-svg) for geometric accuracy,
 * and passes the result to ultra-fast native Rust/C++ renderers (@resvg/resvg-js + sharp).
 */

import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import sharp from 'sharp';
import bmp from 'bmp-js';
import { compileCadIrToSvg, type SvgRenderOptions, type SvgPreset } from '@lavinci/v4-ir-to-svg';

// We duck-type SemanticCadIR here so we don't need a strict structural dependency, 
// but it is completely compatible with v4-dwg-to-ir's output.
// We can just use 'any' for the IR type, or a minimal interface. 
// Using any is easiest since the actual type is massive and provided by another package.
// We will export a typed version if they pass it in.

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'tiff' | 'bmp';

export interface RasterRenderOptions extends SvgRenderOptions {
  /** Output image format (default: 'png') */
  format?: ImageFormat;
  
  /** 
   * Quality for JPEG and WEBP formats (0-100).
   * Default: 85
   */
  quality?: number;

  /**
   * Scale factor / Density multiplier for the output raster.
   * e.g. a multiplier of 2.0 will render at 2x the SVG's intrinsic resolution.
   * Default: 1.0
   */
  resolutionMultiplier?: number;
  
  /**
   * Physical density (Dots Per Inch) embedded into the image metadata.
   * Crucial for precise physical printing (e.g., 300 DPI for blueprints).
   * Default: 72
   */
  dpi?: number;

  /**
   * Override background color for the raster image.
   * By default, it uses the theme's background from the SVG compiler.
   */
  backgroundColor?: string;
}

export interface RasterCompilationResult {
  /** Raw binary image data */
  buffer: Buffer;
  /** Actual width of the generated raster image in pixels */
  width: number;
  /** Actual height of the generated raster image in pixels */
  height: number;
  /** Output format used */
  format: ImageFormat;
  /** Internal tracking: amount of entities rendered in the intermediate SVG */
  entityCount: number;
  /** Internal tracking: elapsed time in milliseconds */
  timeMs: number;
}

/**
 * Compiles a Semantic CAD IR document directly into a rasterized image buffer (PNG/JPEG/WEBP/TIFF/BMP).
 * 
 * Pipeline:
 * 1. IR -> SVG (using @lavinci/v4-ir-to-svg) [Pure Math]
 * 2. SVG -> Pixels (using @resvg/resvg-js)  [Rust Native]
 * 3. Pixels -> Buffer (using sharp)         [C++ Native]
 * 
 * @param ir - The SemanticCadIR document from v4-dwg-to-ir
 * @param options - Rasterization and thematic options
 * @returns Buffer containing the requested image format and metadata
 */
export async function compileCadIrToRaster(
  ir: any,
  options: RasterRenderOptions = {}
): Promise<RasterCompilationResult> {
  const t0 = performance.now();

  const format = options.format || 'png';
  const quality = options.quality ?? 85;
  const resolutionMultiplier = options.resolutionMultiplier ?? 1.0;
  const dpi = options.dpi || 72;

  // 1. Compile to SVG string using the existing reliable Spoke 2
  // We can also pass a cropWindow here if v4-ir-to-svg supported it, but for now we render full model space.
  const svgResult = compileCadIrToSvg(ir, options);

  // 2. Memory Safety Clamp (Prevent OOM attacks / billion-pixel allocations)
  const MAX_DIMENSION = 16384; // 16K resolution max
  
  // Calculate base width (either explicit targetWidth or derived from CAD coordinate bounds)
  const baseWidth = options.targetWidth ? options.targetWidth : svgResult.width;
  const baseHeight = options.targetHeight ? options.targetHeight : svgResult.height;
  
  let safeMultiplier = resolutionMultiplier;
  const predictedWidth = baseWidth * safeMultiplier;
  const predictedHeight = baseHeight * safeMultiplier;

  if (predictedWidth > MAX_DIMENSION || predictedHeight > MAX_DIMENSION) {
    const scaleX = MAX_DIMENSION / baseWidth;
    const scaleY = MAX_DIMENSION / baseHeight;
    safeMultiplier = Math.max(0.0001, Math.min(scaleX, scaleY));
    console.warn(`[Raster Spoke] Warning: Requested resolution exceeded ${MAX_DIMENSION}px safety limit. Clamping multiplier from ${resolutionMultiplier} to ${safeMultiplier.toFixed(4)}.`);
  }

  // 3. Prepare Resvg options
  const resvgOpts: ResvgRenderOptions = {
    fitTo: {
      mode: 'zoom',
      value: safeMultiplier
    },
    // Prevent resvg from downloading external fonts/images (security/speed)
    font: { loadSystemFonts: false }, 
    imageRendering: 1, // shape-rendering optimization
  };

  if (options.backgroundColor) {
    resvgOpts.background = options.backgroundColor;
  }

  // 4. Render SVG string to pixels
  const resvg = new Resvg(svgResult.svg, resvgOpts);
  const renderResult = resvg.render();

  const width = renderResult.width;
  const height = renderResult.height;
  let finalBuffer: Buffer;

  // 5. Encode to requested format
  let sharpInstance = sharp(renderResult.pixels, {
    raw: {
      width,
      height,
      channels: 4
    }
  });

  // Embed physical print DPI metadata
  if (options.dpi) {
    sharpInstance = sharpInstance.withMetadata({ density: options.dpi });
  }

  if (format === 'png') {
    // If DPI is specified, we must use Sharp to embed it. Otherwise use ultra-fast resvg native PNG.
    if (options.dpi) {
      finalBuffer = await sharpInstance.png().toBuffer();
    } else {
      finalBuffer = renderResult.asPng();
    }
  } else if (format === 'jpeg') {
    finalBuffer = await sharpInstance
      .flatten({ background: options.backgroundColor || '#ffffff' })
      .jpeg({ quality })
      .toBuffer();
  } else if (format === 'webp') {
    finalBuffer = await sharpInstance
      .webp({ quality })
      .toBuffer();
  } else if (format === 'tiff') {
    finalBuffer = await sharpInstance
      .tiff({ compression: 'lzw' })
      .toBuffer();
  } else if (format === 'bmp') {
    const bgraBuffer = await sharpInstance
      .flatten({ background: options.backgroundColor || '#ffffff' })
      .ensureAlpha()
      .raw()
      .toBuffer();
    
    const abgrBuffer = Buffer.alloc(bgraBuffer.length);
    for (let i = 0; i < bgraBuffer.length; i += 4) {
      abgrBuffer[i] = 255;
      abgrBuffer[i+1] = bgraBuffer[i+2];
      abgrBuffer[i+2] = bgraBuffer[i+1];
      abgrBuffer[i+3] = bgraBuffer[i];
    }
    
    const bmpData = bmp.encode({
      data: abgrBuffer,
      width,
      height
    });
    finalBuffer = bmpData.data;
  } else {
    throw new Error(`Unsupported format: ${format}`);
  }

  const t1 = performance.now();

  return {
    buffer: finalBuffer,
    width,
    height,
    format,
    entityCount: svgResult.entityCount,
    timeMs: t1 - t0
  };
}
