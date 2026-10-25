import { ApifyClient } from 'apify-client';
import { HttpError } from './http.js';

export type ApifyActorRunner = (
  token: string,
  actorId: string,
  input: Record<string, unknown>,
  options: { limit: number; maxTotalChargeUsd: number },
) => Promise<unknown[]>;

/** Runs an Actor with the official SDK, waits for it, and returns its default dataset items. */
export const runApifyActor: ApifyActorRunner = async (token, actorId, input, { limit, maxTotalChargeUsd }) => {
  const client = new ApifyClient({ token });
  const run = await client.actor(actorId).call(input, { memory: 512, timeout: 120, waitSecs: 150, maxTotalChargeUsd });
  if (run.status !== 'SUCCEEDED') {
    throw new HttpError(502, `The Apify actor run ended as ${run.status}. Open run ${run.id} in the Apify console to read its log.`);
  }
  const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit, clean: true });
  return items;
};
