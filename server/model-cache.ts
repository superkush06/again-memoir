/**
 * pipeline() checks for preprocessor_config.json through transformers.js's own
 * cache, ignoring cache_dir, and asks huggingface.co when it misses: a network
 * round trip on every process start and a load failure when offline, even with
 * the model already downloaded. Pointing that cache at the app's model directory
 * keeps downloaded models fully local. Every model here shares one directory.
 */
export async function useLocalModelCache(cacheDir: string) {
  const { env } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir;
}
