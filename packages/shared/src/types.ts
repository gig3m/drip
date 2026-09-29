export interface UploadResult {
  id: string;
  url: string;
  filename: string;
  size: number;
  content_type: string;
  expires_at: string;
}
export interface UploadManyResult { items: UploadResult[] }
export interface UploadOptions { ttl?: string }
export interface FileListItem {
  id: string;
  url: string;
  filename: string;
  size: number;
  content_type: string;
  created_at: string;
  expires_at: string;
}
