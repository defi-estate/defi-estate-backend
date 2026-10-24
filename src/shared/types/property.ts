export const PROPERTY_STATUSES = ['draft', 'pending_review', 'tokenized', 'archived'] as const;
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

export const PROPERTY_TYPES = ['residential', 'commercial', 'mixed_use', 'land'] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

/**
 * Allowed property lifecycle transitions.
 *
 * - draft -> pending_review
 * - pending_review -> draft | tokenized
 * - tokenized -> archived
 * - archived -> (terminal)
 */
export const allowedTransitions: Record<PropertyStatus, readonly PropertyStatus[]> = {
  draft: ['pending_review'],
  pending_review: ['draft', 'tokenized'],
  tokenized: ['archived'],
  archived: [],
};

/**
 * Returns true when moving from `from` to `to` is a permitted lifecycle transition.
 */
export function isAllowedTransition(from: PropertyStatus, to: PropertyStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export interface PropertyImage {
  id: string;
  propertyId: string;
  url: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface Property {
  id: string;
  name: string;
  description: string;
  type: PropertyType;
  status: PropertyStatus;
  location: {
    address: string;
    city: string;
    country: string;
  };
  /** Appraised value in USD cents. */
  valuationUsdCents: number;
  /** Total number of shares the property is split into. */
  totalShares: number;
  /** Price of a single share in USD cents. */
  sharePriceUsdCents: number;
  /** Expected annual rental yield in basis points (650 = 6.50%). */
  expectedYieldBps: number;
  /** Soroban contract ID of the property share token, once deployed. */
  tokenContractId: string | null;
  imageUrl: string | null;
  /** Uploaded images stored in S3-compatible storage. */
  images?: PropertyImage[];
  createdAt: string;
  updatedAt: string;
}