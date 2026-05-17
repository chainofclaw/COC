import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const libDir = dirname(fileURLToPath(import.meta.url))
const websiteRoot = join(libDir, "..")

async function readWebsiteFile(...parts: string[]): Promise<string> {
  return readFile(join(websiteRoot, ...parts), "utf-8")
}

describe("forum route security checks", () => {
  it("keeps ownership and target existence helpers available", async () => {
    const source = await readWebsiteFile("lib", "forum-queries.ts")

    assert.match(source, /export function isPostAuthor\(/)
    assert.match(source, /export function replyBelongsToPost\(/)
    assert.match(source, /export function voteTargetExists\(/)
  })

  it("requires post authorship before proposal promotion", async () => {
    const source = await readWebsiteFile("app", "api", "forum", "posts", "[id]", "promote", "route.ts")

    assert.match(source, /isPostAuthor\(postId,\s*(address|signerAddress)\)/)
    assert.match(source, /Only the post author can link a proposal/)
  })

  it("requires vote targets and parent replies to exist under the route post", async () => {
    const voteRoute = await readWebsiteFile("app", "api", "forum", "posts", "[id]", "vote", "route.ts")
    const replyRoute = await readWebsiteFile("app", "api", "forum", "posts", "[id]", "replies", "route.ts")

    assert.match(voteRoute, /voteTargetExists\(targetType,\s*targetId,\s*postId\)/)
    assert.match(replyRoute, /replyBelongsToPost\(parentReplyId,\s*postId\)/)
  })
})
