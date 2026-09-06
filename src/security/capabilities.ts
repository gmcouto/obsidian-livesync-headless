const ReadCapabilityBrand = Symbol('ReadCapability');
const AdmissionCapabilityBrand = Symbol('AdmissionCapability');
const VaultReflectCapabilityBrand = Symbol('VaultReflectCapability');
const WriteCapabilityBrand = Symbol('WriteCapability');
const ArmedSyncCapabilityBrand = Symbol('ArmedSyncCapability');

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

export interface VaultReflectCapability {
  readonly [VaultReflectCapabilityBrand]: true;
  readonly baseUrl: URL;
  readonly databaseName: string;
  readonly vaultRoot: string;
  readonly issuedAt: Date;
}

export interface WriteCapability {
  readonly [WriteCapabilityBrand]: true;
  readonly baseUrl: URL;
  readonly databaseName: string;
  readonly grantId: string;
  readonly remoteFingerprint: string;
  readonly vaultRoot: string;
  readonly issuedAt: Date;
}

export interface ArmedSyncCapability {
  readonly [ArmedSyncCapabilityBrand]: true;
  readonly baseUrl: URL;
  readonly databaseName: string;
  readonly grantId: string;
  readonly remoteFingerprint: string;
  readonly vaultRoot: string;
  readonly issuedAt: Date;
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

export function createVaultReflectCapability(
  baseUrl: URL,
  databaseName: string,
  vaultRoot: string
): VaultReflectCapability {
  return {
    [VaultReflectCapabilityBrand]: true,
    baseUrl: new URL(baseUrl.href),
    databaseName,
    vaultRoot,
    issuedAt: new Date(),
  };
}

export function createWriteCapability(
  baseUrl: URL,
  databaseName: string,
  grantId: string,
  remoteFingerprint: string,
  vaultRoot: string
): WriteCapability {
  return {
    [WriteCapabilityBrand]: true,
    baseUrl: new URL(baseUrl.href),
    databaseName,
    grantId,
    remoteFingerprint,
    vaultRoot,
    issuedAt: new Date(),
  };
}

export function createArmedSyncCapability(
  baseUrl: URL,
  databaseName: string,
  grantId: string,
  remoteFingerprint: string,
  vaultRoot: string
): ArmedSyncCapability {
  return {
    [ArmedSyncCapabilityBrand]: true,
    baseUrl: new URL(baseUrl.href),
    databaseName,
    grantId,
    remoteFingerprint,
    vaultRoot,
    issuedAt: new Date(),
  };
}

export function isReadCapability(cap: unknown): cap is ReadCapability {
  return Boolean(cap && typeof cap === 'object' && ReadCapabilityBrand in cap);
}

export function isAdmissionCapability(cap: unknown): cap is AdmissionCapability {
  return Boolean(cap && typeof cap === 'object' && AdmissionCapabilityBrand in cap);
}

export function isVaultReflectCapability(cap: unknown): cap is VaultReflectCapability {
  return Boolean(cap && typeof cap === 'object' && VaultReflectCapabilityBrand in cap);
}

export function isWriteCapability(cap: unknown): cap is WriteCapability {
  return Boolean(cap && typeof cap === 'object' && WriteCapabilityBrand in cap);
}

export function isArmedSyncCapability(cap: unknown): cap is ArmedSyncCapability {
  return Boolean(cap && typeof cap === 'object' && ArmedSyncCapabilityBrand in cap);
}
