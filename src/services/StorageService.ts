import {
  S3Client,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

import { env } from '../config/env';

export interface UploadParams {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface UploadResult {
  url: string;
}

export interface StorageService {
  upload(params: UploadParams): Promise<UploadResult>;
}

export class S3StorageService implements StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;

  constructor(client?: S3Client) {
    this.bucket = env.S3_BUCKET;
    this.endpoint = env.S3_ENDPOINT;

    this.client =
      client ??
      new S3Client({
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT,
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        },
        forcePathStyle: true,
      });
  }

  async upload({ key, body, contentType }: UploadParams): Promise<UploadResult> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );

    return { url: this.buildObjectUrl(key) };
  }

  private buildObjectUrl(key: string): string {
    const base = this.endpoint.replace(/\/+$/, '');
    return `${base}/${this.bucket}/${key}`;
  }
}