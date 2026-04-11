// Embed path type.
//
// An EmbedPath is the dot-separated chain from a URL like
// `actors.films.id=eq.5` → `['actors', 'films']`. An empty array means
// the filter/order/logic lives at the root of the query.

export type EmbedPath = readonly string[];
