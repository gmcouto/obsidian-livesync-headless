const ReadCapabilityBrand = Symbol('ReadCapability');
const AdmissionCapabilityBrand = Symbol('AdmissionCapability');

export interface ReadCapability {
  readonly [ReadCapabilityBrand]: true;
  readonly baseUrl: URL;
  readonly databaseName: string;
  readonly issuedAt: Date;
}

export interface AdmissionCapability {
  readonly [AdmissionCapabilityBrand]: true;
  readonly baseUrl: URL;
  readonly databaseName: string;
  readonly remoteFingerprint: string;
  readonly negotiatedSettingsHash: string;
  readonly admittedAt: Date;
}

export function createReadCapability(baseUrl: URL, databaseName: string): ReadCapability {
  return {
    [ReadCapabilityBrand]: true,
    baseUrl: new URL(baseUrl.href),
    databaseName,
    issuedAt: new Date(),
  };
}

export function createAdmissionCapability(
  baseUrl: URL,
  databaseName: string,
  remoteFingerprint: string,
  negotiatedSettingsHash: string
): AdmissionCapability {
  return {
    [AdmissionCapabilityBrand]: true,
    baseUrl: new URL(baseUrl.href),
    databaseName,
    remoteFingerprint,
    negotiatedSettingsHash,
    admittedAt: new Date(),
  };
}

export function isReadCapability(cap: unknown): cap is ReadCapability {
  return Boolean(cap && typeof cap === 'object' && ReadCapabilityBrand in cap);
}

export function isAdmissionCapability(cap: unknown): cap is AdmissionCapability {
  return Boolean(cap && typeof cap === 'object' && AdmissionCapabilityBrand in cap);
}
