import type { PublishingProviderId } from "@tss/shared";

import { BufferProvider } from "./providers/buffer";
import { ThreadsProvider } from "./providers/threads";
import type { PublishingProvider } from "./types";

let registry: Record<PublishingProviderId, PublishingProvider> = {
  threads: new ThreadsProvider(),
  buffer: new BufferProvider(),
};

export const getPublishingProvider = (id: PublishingProviderId) => registry[id];
export const allPublishingProviders = () => Object.values(registry);

/** Test hook. */
export function setPublishingProvidersForTests(next: Partial<Record<PublishingProviderId, PublishingProvider>>) {
  registry = { ...registry, ...next } as Record<PublishingProviderId, PublishingProvider>;
}
