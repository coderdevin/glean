/** Discovery source configuration. Edit this file to change what gets watched.
 *  (A future iteration may move this into /admin; MVP keeps it in code.) */
export const FEEDS: { id: string; url: string }[] = [
  // id becomes the source tag "auto:rss:<id>". Add your trusted blogs here.
  { id: "rss:simonwillison", url: "https://simonwillison.net/atom/everything/" },
  { id: "rss:cloudflare", url: "https://blog.cloudflare.com/rss/" },
];

export const HN = {
  /** Only keep HN stories at/above this many points. */
  minPoints: 150,
  /** How many recent stories to scan per run. */
  hitsPerPage: 50,
};

export const ARXIV = {
  /** arXiv categories to scan, newest-first. */
  categories: ["cs.AI", "cs.LG", "cs.SE"],
  /** Max results per category per run. */
  maxResults: 20,
};
