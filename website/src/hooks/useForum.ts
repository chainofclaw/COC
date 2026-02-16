'use client'

import { useState, useCallback } from 'react'

export interface Post {
  id: number
  title: string
  content: string
  author_address: string
  category: string
  tags: string | null
  proposal_id: number | null
  upvotes: number
  downvotes: number
  reply_count: number
  pinned: number
  created_at: number
  updated_at: number
  author_faction?: string
  author_display_name?: string
}

export interface Reply {
  id: number
  post_id: number
  parent_reply_id: number | null
  content: string
  author_address: string
  upvotes: number
  downvotes: number
  created_at: number
  author_faction?: string
  author_display_name?: string
}

interface UseForumReturn {
  posts: Post[]
  total: number
  loading: boolean
  error: string | null
  fetchPosts: (params?: Record<string, string>) => Promise<void>
  createPost: (data: { title: string; content: string; category: string; signature: string; address: string }) => Promise<Post>
  fetchReplies: (postId: number) => Promise<Reply[]>
  createReply: (data: { post_id: number; content: string; signature: string; address: string; parent_reply_id?: number }) => Promise<Reply>
  castVote: (targetType: string, targetId: number, voteType: string, address: string, signature: string) => Promise<{ upvotes: number; downvotes: number }>
}

export function useForum(): UseForumReturn {
  const [posts, setPosts] = useState<Post[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchPosts = useCallback(async (params: Record<string, string> = {}) => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams(params).toString()
      const res = await fetch(`/api/forum/posts${qs ? `?${qs}` : ''}`)
      if (!res.ok) throw new Error('Failed to fetch posts')
      const data = await res.json()
      setPosts(data.posts)
      setTotal(data.total)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const createPost = useCallback(async (data: {
    title: string
    content: string
    category: string
    signature: string
    address: string
  }): Promise<Post> => {
    const res = await fetch('/api/forum/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Failed to create post')
    }
    return res.json()
  }, [])

  const fetchReplies = useCallback(async (postId: number): Promise<Reply[]> => {
    const res = await fetch(`/api/forum/posts/${postId}`)
    if (!res.ok) throw new Error('Failed to fetch replies')
    const data = await res.json()
    return data.replies
  }, [])

  const createReply = useCallback(async (data: {
    post_id: number
    content: string
    signature: string
    address: string
    parent_reply_id?: number
  }): Promise<Reply> => {
    const res = await fetch(`/api/forum/posts/${data.post_id}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Failed to create reply')
    }
    return res.json()
  }, [])

  const castVote = useCallback(async (
    targetType: string,
    targetId: number,
    voteType: string,
    address: string,
    signature: string,
  ): Promise<{ upvotes: number; downvotes: number }> => {
    const res = await fetch(`/api/forum/posts/${targetId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_type: targetType, vote_type: voteType, address, signature }),
    })
    if (!res.ok) throw new Error('Failed to vote')
    return res.json()
  }, [])

  return { posts, total, loading, error, fetchPosts, createPost, fetchReplies, createReply, castVote }
}
