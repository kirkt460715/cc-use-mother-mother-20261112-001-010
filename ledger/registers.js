import { fields, array, id, text, integer, money, dollars, add, index, clone, digest, Invalid } from './values.js';

export const TABLES = ['projects', 'appropriations', 'disbursements', 'expenses', 'milestones', 'deliverables', 'reversals'];

function project(row) {
  fields(row, ['id', 'county', 'program', 'name', 'start', 'end', 'status']);
  id(row.county, 'county');
  id(row.program, 'program');
  text(row.name, 'project name');
  integer(row.start, 'project start', 2000, 2100);
  integer(row.end, 'project end', row.start, 2100);
  if (!['planned', 'active', 'suspended', 'completed', 'cancelled'].includes(row.status)) {
    throw new Invalid('unknown project status');
  }
}

function appropriation(row) {
  fields(row, ['id', 'project', 'fiscal_year', 'authorized', 'source']);
  id(row.project, 'project');
  integer(row.fiscal_year, 'fiscal_year', 2000, 2100);
  money(row.authorized, 'authorized');
  text(row.source, 'funding source');
}

function disbursement(row) {
  fields(row, ['id', 'appropriation', 'date', 'amount', 'kind', 'external_ref']);
  id(row.appropriation, 'appropriation');
  integer(row.date, 'disbursement date', 20000101, 21001231);
  money(row.amount, 'disbursement amount');
  if (!['payment', 'refund', 'void'].includes(row.kind)) {
    throw new Invalid('invalid disbursement kind');
  }
  text(row.external_ref, 'external_ref', 150);
}

function expense(row) {
  fields(row, ['id', 'project', 'date', 'amount', 'category', 'vendor_ref']);
  id(row.project, 'project');
  integer(row.date, 'expense date', 20000101, 21001231);
  money(row.amount, 'expense amount');
  id(row.category, 'category');
  text(row.vendor_ref, 'vendor_ref', 150);
}

function milestone(row) {
  fields(row, ['id', 'project', 'code', 'due_date', 'required']);
  id(row.project, 'project');
  id(row.code, 'milestone code');
  integer(row.due_date, 'due_date', 20000101, 21001231);
  if (typeof row.required !== 'boolean') {
    throw new Invalid('required must be boolean');
  }
}

function deliverable(row) {
  fields(row, ['id', 'project', 'milestone', 'accepted_date', 'units', 'evidence_ref']);
  id(row.project, 'project');
  id(row.milestone, 'milestone');
  if (row.accepted_date !== null) {
    integer(row.accepted_date, 'accepted_date', 20000101, 21001231);
  }
  integer(row.units, 'units', 0, 1000000000);
  text(row.evidence_ref, 'evidence_ref', 200);
}

function reversal(row) {
  fields(row, ['id', 'disbursement', 'reversal_of', 'date', 'amount', 'reason']);
  id(row.disbursement, 'disbursement');
  id(row.reversal_of, 'reversal_of');
  integer(row.date, 'reversal date', 20000101, 21001231);
  money(row.amount, 'reversal amount');
  text(row.reason, 'reversal reason');
}

const VALIDATORS = {
  projects: project,
  appropriations: appropriation,
  disbursements: disbursement,
  expenses: expense,
  milestones: milestone,
  deliverables: deliverable,
  reversals: reversal
};

export class Registers {
  constructor(document) {
    fields(document, ['version', ...TABLES]);
    if (document.version !== 1) {
      throw new Invalid('unsupported register version');
    }
    this.document = clone(document);
    for (const table of TABLES) {
      array(this.document[table], table, 100000);
      for (const row of this.document[table]) {
        VALIDATORS[table](row);
      }
      this.document[table].sort((a, b) => a.id.localeCompare(b.id));
      this[table] = index(this.document[table], table);
    }
    this.references();
    this.fingerprint = digest(this.document);
  }

  references() {
    for (const row of this.appropriations.values()) {
      if (!this.projects.has(row.project)) {
        throw new Invalid('appropriation project missing');
      }
    }
    for (const row of this.disbursements.values()) {
      if (!this.appropriations.has(row.appropriation)) {
        throw new Invalid('disbursement appropriation missing');
      }
    }
    for (const row of this.expenses.values()) {
      if (!this.projects.has(row.project)) {
        throw new Invalid('expense project missing');
      }
    }
    for (const row of this.milestones.values()) {
      if (!this.projects.has(row.project)) {
        throw new Invalid('milestone project missing');
      }
    }
    for (const row of this.deliverables.values()) {
      const target = this.milestones.get(row.milestone);
      if (!this.projects.has(row.project) || !target || target.project !== row.project) {
        throw new Invalid('deliverable milestone reference mismatch');
      }
      if (row.accepted_date === null && row.units !== 0) {
        throw new Invalid('unaccepted deliverable cannot count units');
      }
    }
    const reversed = new Set();
    for (const row of this.reversals.values()) {
      const payment = this.disbursements.get(row.disbursement);
      const original = this.disbursements.get(row.reversal_of);
      if (!payment || !original || payment.kind !== 'refund' || original.kind !== 'payment' || payment.appropriation !== original.appropriation) {
        throw new Invalid('reversal must link refund to payment in same appropriation');
      }
      if (payment.date !== row.date || money(payment.amount) !== money(row.amount)) {
        throw new Invalid('reversal event fields mismatch');
      }
      if (row.date < original.date) {
        throw new Invalid('reversal predates payment');
      }
      if (reversed.has(row.disbursement)) {
        throw new Invalid('refund can only reverse one payment');
      }
      reversed.add(row.disbursement);
    }
    for (const row of this.disbursements.values()) {
      if (row.kind === 'refund' && !reversed.has(row.id)) {
        throw new Invalid('refund lacks reversal record');
      }
    }
  }

  export() {
    return clone(this.document);
  }
}

export function cashEffect(registers, disbursement) {
  if (disbursement.kind === 'void') {
    return 0;
  }
  if (disbursement.kind === 'refund') {
    const reversal = [...registers.reversals.values()].find(row => row.disbursement === disbursement.id);
    if (!reversal) {
      throw new Invalid('refund effect without reversal link');
    }
    return -money(reversal.amount);
  }
  return money(disbursement.amount);
}

export function netCash(registers, appropriationId) {
  const rows = [...registers.disbursements.values()].filter(row => row.appropriation === appropriationId);
  return rows.reduce((sum, row) => sum + cashEffect(registers, row), 0);
}

export function appropriationBalance(registers, appropriationId) {
  const appropriation = registers.appropriations.get(appropriationId);
  if (!appropriation) {
    throw new Invalid('unknown appropriation');
  }
  const authorized = money(appropriation.authorized);
  const cash = netCash(registers, appropriationId);
  return {
    appropriation: appropriationId,
    authorized_cents: authorized,
    net_disbursed_cents: cash,
    remaining_cents: authorized - cash,
    overdrawn: cash > authorized,
    authorized: dollars(authorized),
    net_disbursed: dollars(cash),
    remaining: dollars(authorized - cash)
  };
}

export function fiscalYear(date) {
  integer(date, 'date', 20000101, 21001231);
  return Math.floor(date / 10000);
}
