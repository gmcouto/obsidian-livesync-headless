import type { OutcomeCategory } from './outcomes.js';

export interface CompatibilityReport {
  readonly outcome: OutcomeCategory;
  readonly remoteFingerprint: string;
  readonly negotiatedSettingsHash: string;
  readonly admittedCapabilities: readonly string[];
  readonly unsupportedCapabilities: readonly string[];
  readonly adoptedTweaks: Record<string, unknown>;
  readonly blockers: readonly {
    readonly code: string;
    readonly message: string;
    readonly suggestion?: string;
  }[];
  readonly zeroMutationVerified: boolean;
  readonly preUpdateSeq?: string;
  readonly postUpdateSeq?: string;
  readonly databaseInfo?: {
    readonly docCount: number;
    readonly updateSeq: string;
    readonly couchdbVersion?: string;
  };
}

export function formatHumanReport(report: CompatibilityReport): string {
  const lines: string[] = [];
  const divider = '─'.repeat(70);

  lines.push(divider);
  lines.push(`  OBSIDIAN LIVESYNC ADMISSION REPORT: [${report.outcome}]`);
  lines.push(divider);

  if (report.remoteFingerprint) {
    lines.push(`  Remote Fingerprint:       ${report.remoteFingerprint}`);
  }
  if (report.negotiatedSettingsHash) {
    lines.push(`  Negotiated Settings Hash: ${report.negotiatedSettingsHash}`);
  }

  if (report.databaseInfo) {
    lines.push(`  CouchDB Version:          ${report.databaseInfo.couchdbVersion ?? 'Unknown'}`);
    lines.push(`  Remote Document Count:    ${report.databaseInfo.docCount}`);
    lines.push(`  Remote Update Seq:        ${report.databaseInfo.updateSeq}`);
  }

  lines.push('');
  lines.push('  Zero-Mutation Verification:');
  lines.push(`    Verified:               ${report.zeroMutationVerified ? 'PASS (Zero mutations detected)' : 'FAIL (Mutation detected)'}`);
  if (report.preUpdateSeq !== undefined && report.postUpdateSeq !== undefined) {
    lines.push(`    Pre-probe update_seq:   ${report.preUpdateSeq}`);
    lines.push(`    Post-probe update_seq:  ${report.postUpdateSeq}`);
  }

  lines.push('');
  lines.push('  Admitted Capabilities:');
  if (report.admittedCapabilities.length > 0) {
    for (const cap of report.admittedCapabilities) {
      lines.push(`    • ${cap}`);
    }
  } else {
    lines.push('    (None - admission denied)');
  }

  lines.push('');
  lines.push('  Unsupported Capabilities:');
  if (report.unsupportedCapabilities.length > 0) {
    for (const cap of report.unsupportedCapabilities) {
      lines.push(`    • ${cap}`);
    }
  } else {
    lines.push('    (None)');
  }

  lines.push('');
  lines.push('  Adopted Remote Tweaks:');
  const tweakEntries = Object.entries(report.adoptedTweaks);
  if (tweakEntries.length > 0) {
    for (const [k, v] of tweakEntries) {
      lines.push(`    • ${k}: ${JSON.stringify(v)}`);
    }
  } else {
    lines.push('    (None)');
  }

  if (report.blockers.length > 0) {
    lines.push('');
    lines.push('  Blockers:');
    for (const blocker of report.blockers) {
      lines.push(`    ✖ [${blocker.code}] ${blocker.message}`);
      if (blocker.suggestion) {
        lines.push(`      Suggestion: ${blocker.suggestion}`);
      }
    }
  }

  lines.push(divider);
  return lines.join('\n') + '\n';
}

export function formatJsonLinesReport(report: CompatibilityReport): string {
  return (
    JSON.stringify({
      type: 'compatibility_report',
      outcome: report.outcome,
      remoteFingerprint: report.remoteFingerprint,
      negotiatedSettingsHash: report.negotiatedSettingsHash,
      admittedCapabilities: report.admittedCapabilities,
      unsupportedCapabilities: report.unsupportedCapabilities,
      adoptedTweaks: report.adoptedTweaks,
      blockers: report.blockers,
      zeroMutationVerified: report.zeroMutationVerified,
      preUpdateSeq: report.preUpdateSeq,
      postUpdateSeq: report.postUpdateSeq,
      databaseInfo: report.databaseInfo,
    }) + '\n'
  );
}
