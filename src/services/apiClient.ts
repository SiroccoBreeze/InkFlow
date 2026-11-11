/**
 * InkFlow Full-Stack API Client
 * Seamlessly interfaces with Node/Express /api/v1 backend,
 * persisting to physical Markdown files in storage/documents/ and native SQLite.
 */

const API_BASE = '/api/v1';

export interface ApiResponse<T = any> {
  data?: T;
  meta?: any;
  error?: {
    code: string;
    message: string;
    details?: any;
    /** HTTP status (0 for network failures). Used to distinguish 409 / retryable errors. */
    status?: number;
  };
}

class ApiClient {
  private token: string | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.token = localStorage.getItem('inkflow_auth_token');
    }
  }

  public setToken(token: string | null) {
    this.token = token;
    if (typeof window !== 'undefined') {
      if (token) {
        localStorage.setItem('inkflow_auth_token', token);
      } else {
        localStorage.removeItem('inkflow_auth_token');
      }
    }
  }

  public getToken(): string | null {
    return this.token;
  }

  private async request<T = any>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) || {}),
    };

    const token =
      this.token ||
      (typeof window !== 'undefined'
        ? localStorage.getItem('inkflow_auth_token') ||
          (JSON.parse(localStorage.getItem('inkflow_session_v1') || '{}') as any)?.token
        : null);

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers,
      });

      let data: any = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok) {
        return {
          error: {
            code: data?.error?.code || `HTTP_${response.status}`,
            message: data?.error?.message || `请求失败（HTTP ${response.status}）`,
            details: data?.error?.details,
            status: response.status,
          },
        };
      }

      return data ?? {};
    } catch (err: any) {
      return {
        error: {
          code: 'NETWORK_ERROR',
          message: err?.message || '无法连接到后端持久化服务',
          status: 0,
        },
      };
    }
  }

  // --- Auth API ---
  public async getAuthStatus() {
    return this.request<{ isInitialized: boolean; canInitialize: boolean }>('/auth/status');
  }

  public async initOwner(params: { initKey: string; username?: string; password: string; email?: string }) {
    const res = await this.request<{ user: any; token: string; recoveryCode: string; message: string }>('/auth/init', {
      method: 'POST',
      body: JSON.stringify(params),
    });

    if (res.data?.token) {
      this.setToken(res.data.token);
    }
    return res;
  }

  public async login(password: string) {
    const res = await this.request<{ user: any; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });

    if (res.data?.token) {
      this.setToken(res.data.token);
    }
    return res;
  }

  public async getMe() {
    return this.request<{ user: any; isOwner: boolean }>('/auth/me');
  }


  public async logout() {
    await this.request('/auth/logout', { method: 'POST' });
    this.setToken(null);
  }

  public async changePassword(newPassword: string) {
    return this.request('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    });
  }

  public async resetPassword(params: {
    username?: string;
    oldPassword?: string;
    recoveryCode?: string;
    newPassword: string;
  }) {
    return this.request<{ success: boolean; message: string; newRecoveryCode?: string }>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }


  public async getProfile() {
    return this.request<any>('/users/profile');
  }

  public async updateProfile(profile: { username?: string; email?: string }) {
    return this.request<{ success: boolean; profile: any }>('/users/profile', {
      method: 'PUT',
      body: JSON.stringify(profile),
    });
  }

  // --- Documents API ---
  public async getDocuments(params?: {
    visibility?: string;
    category?: string;
    tag?: string;
    search?: string;
  }) {
    const query = new URLSearchParams(params as any).toString();
    return this.request<any[]>(`/documents${query ? `?${query}` : ''}`);
  }

  public async getDocumentById(id: string) {
    return this.request(`/documents/${id}`);
  }

  /**
   * @param options.create force POST semantics for a brand-new document even
   *   though a client-generated id is present (the id is used as the queue key).
   */
  public async saveDocument(docInput: any, note?: string, options?: { create?: boolean }) {
    const isCreate = options?.create === true;
    const method = isCreate ? 'POST' : 'PUT';
    const endpoint = isCreate ? '/documents' : `/documents/${docInput.id}`;

    return this.request(endpoint, {
      method,
      body: JSON.stringify({ ...docInput, note }),
    });
  }

  public async deleteDocument(id: string) {
    return this.request(`/documents/${id}`, {
      method: 'DELETE',
    });
  }

  // --- Search API ---
  public async search(q: string, category?: string) {
    const query = new URLSearchParams({ q, ...(category ? { category } : {}) }).toString();
    return this.request<any[]>(`/search?${query}`);
  }

  // --- Shares API ---
  public async createShare(documentId: string, options?: { password?: string; expiresInDays?: number; maxViews?: number }) {
    return this.request<{ shareId: string; token: string }>('/shares', {
      method: 'POST',
      body: JSON.stringify({ documentId, ...options }),
    });
  }

  public async accessShare(token: string, password?: string) {
    return this.request<{ doc: any; share: any }>('/shares/access', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    });
  }

  public async revokeShare(shareId: string) {
    return this.request(`/shares/${shareId}`, {
      method: 'DELETE',
    });
  }

  // --- Revisions & Snapshots API ---
  public async getRevisions(docId: string) {
    return this.request<any[]>(`/documents/${docId}/revisions`);
  }

  public async getRevisionSnapshot(docId: string, revId: string) {
    return this.request<any>(`/documents/${docId}/revisions/${revId}`);
  }

  public async rollbackRevision(docId: string, revId: string) {
    return this.request<any>(`/documents/${docId}/revisions/${revId}/rollback`, {
      method: 'POST',
    });
  }

  // --- Assets & Media API ---
  public async uploadAsset(filename: string, mimeType: string, base64: string) {
    return this.request<{
      id: string;
      filename: string;
      mimeType: string;
      size: number;
      url: string;
      createdAt: string;
    }>('/assets/upload', {
      method: 'POST',
      body: JSON.stringify({ filename, mimeType, base64 }),
    });
  }

  public async getAssets() {
    return this.request<any[]>('/assets');
  }

  public async deleteAsset(id: string) {
    return this.request(`/assets/${id}`, {
      method: 'DELETE',
    });
  }

  public async cleanupOrphanAssets() {
    return this.request<{ success: boolean; cleanedCount: number; freedBytes: number; message: string }>(
      '/assets/cleanup-orphans',
      { method: 'POST' }
    );
  }

  // --- Revisions & Snapshots API ---
  public async getRevisionsOverview() {
    return this.request<{
      totalDocumentsWithRevisions: number;
      totalRevisionsCount: number;
      totalDiskBytes: number;
      groups: Array<{
        documentId: string;
        title: string;
        category: string;
        slug: string;
        updatedAt: string;
        totalBytes: number;
        revisionCount: number;
        latestRevisionAt: string;
        revisions: Array<{
          id: string;
          fileName: string;
          size: number;
          createdAt: string;
          versionNumber: number | null;
          note: string;
          relativePath: string;
        }>;
      }>;
    }>('/revisions/overview');
  }

  public async cleanupRevisions(params: {
    documentId?: string;
    keepLatest?: number;
    all?: boolean;
  }) {
    return this.request<{
      cleanedCount: number;
      freedBytes: number;
      remainingCount: number;
      totalDiskBytes: number;
    }>('/revisions/cleanup', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  public async deleteDocumentRevisions(documentId: string) {
    return this.request<{
      cleanedCount: number;
      freedBytes: number;
      remainingCount: number;
      totalDiskBytes: number;
    }>(`/revisions/${encodeURIComponent(documentId)}`, {
      method: 'DELETE',
    });
  }

  public async deleteSingleRevision(documentId: string, revisionId: string) {
    return this.request<{ success: boolean }>(
      `/revisions/${encodeURIComponent(documentId)}/${encodeURIComponent(revisionId)}`,
      {
        method: 'DELETE',
      }
    );
  }

  // --- Categories & Tags API ---
  public async getCategories() {
    return this.request<any[]>('/categories');
  }

  public async createCategory(category: { name: string; description?: string; slug?: string }) {
    return this.request<{ id: string; name: string }>('/categories', {
      method: 'POST',
      body: JSON.stringify(category),
    });
  }

  public async deleteCategory(idOrName: string) {
    return this.request<{ success: boolean }>(`/categories/${encodeURIComponent(idOrName)}`, {
      method: 'DELETE',
    });
  }

  public async getTags() {
    return this.request<any[]>('/tags');
  }

  public async deleteTag(tagName: string) {
    return this.request<{
      success: boolean;
      /** false when the server still finds documents referencing the tag. */
      tagDeleted?: boolean;
      referencedDocuments?: number;
      reason?: string;
    }>(`/tags/${encodeURIComponent(tagName)}`, {
      method: 'DELETE',
    });
  }

  // --- System API ---
  public async rebuildIndex() {
    return this.request<{ success: boolean; message: string }>('/system/rebuild-index', {
      method: 'POST',
    });
  }

  public async getSystemStats() {
    return this.request<any>('/system/stats');
  }
}

export const apiClient = new ApiClient();
