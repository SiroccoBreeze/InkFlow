/**
 * Core Type Definitions for InkFlow Knowledge Base & Community Forum
 * Extensible for single-owner V1 to multi-user RBAC knowledge forum.
 */

export type DocVisibility = 'public' | 'private' | 'unlisted';

export type UserRole = 'owner' | 'contributor' | 'reader';

export interface Attachment {
  id: string;
  docId?: string;
  name: string;
  size: number;
  mimeType: string;
  dataUrl: string; // Base64 or Blob URL for local-first persistence
  createdAt: string;
}

export interface DocVersion {
  id: string;
  docId: string;
  versionNumber: number;
  title: string;
  rawMarkdown: string;
  timestamp: string;
  note?: string;
  charCount: number;
}

export interface KnowledgeDoc {
  id: string;
  slug: string;
  title: string;
  rawMarkdown: string; // The canonical single source of truth
  category: string;
  tags: string[];
  visibility: DocVisibility;
  unlistedKey?: string; // Unguessable token for unlisted sharing
  author: string;
  createdAt: string;
  updatedAt: string;
  versionCount: number;
  wordCount: number;
  readingTimeMinutes: number;
  attachments?: Attachment[];
  pinned?: boolean;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string;
  color?: string;
  icon?: string;
  order: number;
}

export interface UserSession {
  isOwner: boolean;
  username: string;
  role: UserRole;
  token?: string;
}

export interface TableOfContentItem {
  id: string;
  text: string;
  level: number;
}

export interface CommentItem {
  id: string;
  docId: string;
  authorName: string;
  authorRole: UserRole;
  content: string;
  createdAt: string;
  upvotes: number;
  isPinned?: boolean;
}

export interface ForumTopic {
  id: string;
  title: string;
  content: string;
  category: 'rfc' | 'qa' | 'discussion' | 'changelog';
  authorName: string;
  authorRole: UserRole;
  createdAt: string;
  replyCount: number;
  upvotes: number;
  isResolved?: boolean;
  tags: string[];
  pinned?: boolean;
}

export interface ForumReply {
  id: string;
  topicId: string;
  authorName: string;
  authorRole: UserRole;
  content: string;
  createdAt: string;
  upvotes: number;
}

export interface WikiBacklink {
  sourceDocId: string;
  sourceDocTitle: string;
  sourceDocSlug: string;
  sourceCategory: string;
  excerpt: string;
}

export interface GraphNode {
  id: string;
  label: string;
  category: string;
  type: 'doc' | 'tag';
  val: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

export interface GraphLink {
  source: string;
  target: string;
}
