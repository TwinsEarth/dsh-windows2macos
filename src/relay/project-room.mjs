/**
 * Project room (M4, v1.3.10-beta.12 slice).
 *
 * A project is the shared object a fleet lacks today: tasks, artifacts, memory, decisions and refs belong to it, and every
 * client reads the same membership and the same event sequence. This module owns the object, its members, the permission
 * matrix and the snapshot/event protocol; it deliberately holds no relay state of its own so it can be replayed and tested.
 *
 * Permissions are deny-by-default: an action is allowed only when the member's role is at or above the role the action
 * requires. A role change is an event, like every other mutation, so "who could do what, when" is answerable afterwards.
 */
export const PROJECT_ROLES = Object.freeze(['observer', 'worker', 'maintainer', 'owner']);

const RANK = Object.freeze({ observer: 0, worker: 1, maintainer: 2, owner: 3 });

/** action -> minimum role */
export const PROJECT_ACTIONS = Object.freeze({
  read: 'observer',
  dispatch: 'worker',
  artifact: 'worker',
  lock: 'worker',
  memory: 'maintainer',
  decide: 'maintainer',
  merge: 'maintainer',
  settings: 'maintainer',
  members: 'owner',
});

export class ProjectRoomError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ProjectRoomError';
    this.code = code;
    this.detail = detail;
  }
}

export function createProjectRoom({ now = () => Date.now() } = {}) {
  const projects = new Map();
  const events = [];
  let seq = 0;
  let counter = 0;

  const emit = (projectId, type, actor, payload) => {
    seq += 1;
    const event = { seq, project_id: projectId, type, actor, payload, at: new Date(now()).toISOString() };
    events.push(event);
    return event;
  };

  const requireProject = (projectId) => {
    const project = projects.get(projectId);
    if (!project) throw new ProjectRoomError('PROJECT_NOT_FOUND', 'unknown project', { project_id: projectId });
    return project;
  };

  const findMember = (project, member) => {
    if (!member || typeof member !== 'object' || typeof member.kind !== 'string' || typeof member.id !== 'string') return null;
    return project.members.find((entry) => entry.kind === member.kind && entry.id === member.id) ?? null;
  };

  return {
    /** Create a project; the creator becomes its owner. */
    createProject({ name, origin = null, createdBy, projectId = null }) {
      if (typeof name !== 'string' || name.trim() === '') throw new ProjectRoomError('BAD_REQUEST', 'project name is required');
      if (!createdBy || typeof createdBy.kind !== 'string' || typeof createdBy.id !== 'string') throw new ProjectRoomError('BAD_REQUEST', 'createdBy member is required');
      counter += 1;
      const assigned = typeof projectId === 'string' && projectId !== '' ? projectId : 'prj-' + String(counter).padStart(4, '0') + '-' + now().toString(36);
      if (projects.has(assigned)) throw new ProjectRoomError('DUPLICATE_PROJECT', 'project id already exists', { project_id: assigned });
      const project = {
        project_id: assigned,
        name: name.trim(),
        origin: origin === null ? null : { ...origin },
        created_at: new Date(now()).toISOString(),
        created_by: { ...createdBy },
        settings: { merge_requires_review: false, merge_requires_tests: false },
        members: [{ ...createdBy, role: 'owner', joined_at: new Date(now()).toISOString() }],
      };
      projects.set(assigned, project);
      emit(assigned, 'project.created', createdBy, { name: project.name });
      return { ok: true, project: this.snapshot({ projectId: assigned }) };
    },
    addMember({ projectId, member, role }) {
      const project = requireProject(projectId);
      if (!PROJECT_ROLES.includes(role)) throw new ProjectRoomError('BAD_ROLE', 'unknown role', { role });
      if (!member || typeof member.kind !== 'string' || typeof member.id !== 'string' || typeof member.id === 'undefined') throw new ProjectRoomError('BAD_REQUEST', 'member needs kind and id');
      if (findMember(project, member) !== null) throw new ProjectRoomError('DUPLICATE_MEMBER', 'member already belongs to this project', { member });
      const entry = { kind: member.kind, id: member.id, name: typeof member.name === 'string' ? member.name : null, role, joined_at: new Date(now()).toISOString() };
      project.members.push(entry);
      emit(projectId, 'member.added', member, { role });
      return { ok: true, member: { ...entry } };
    },
    removeMember({ projectId, member }) {
      const project = requireProject(projectId);
      const index = project.members.findIndex((entry) => entry.kind === member?.kind && entry.id === member?.id);
      if (index < 0) throw new ProjectRoomError('MEMBER_NOT_FOUND', 'member does not belong to this project', { member });
      const [removed] = project.members.splice(index, 1);
      if (removed.role === 'owner' && project.members.every((entry) => entry.role !== 'owner')) {
        project.members.splice(index, 0, removed);
        throw new ProjectRoomError('LAST_OWNER', 'a project must keep at least one owner', { member });
      }
      emit(projectId, 'member.removed', member, { role: removed.role });
      return { ok: true };
    },
    setRole({ projectId, member, role }) {
      const project = requireProject(projectId);
      if (!PROJECT_ROLES.includes(role)) throw new ProjectRoomError('BAD_ROLE', 'unknown role', { role });
      const entry = findMember(project, member);
      if (entry === null) throw new ProjectRoomError('MEMBER_NOT_FOUND', 'member does not belong to this project', { member });
      if (entry.role === role) return { ok: true, member: { ...entry }, changed: false };
      const previous = entry.role;
      entry.role = role;
      emit(projectId, 'member.role_changed', member, { from: previous, to: role });
      return { ok: true, member: { ...entry }, changed: true };
    },
    memberOf({ projectId, member }) {
      const project = requireProject(projectId);
      return findMember(project, member);
    },
    /** Deny-by-default permission check. Returns a value; the caller decides whether to throw. */
    mayAct({ projectId, member, action }) {
      const project = requireProject(projectId);
      const required = PROJECT_ACTIONS[action];
      if (!required) throw new ProjectRoomError('BAD_REQUEST', 'unknown action', { action });
      const entry = findMember(project, member);
      if (entry === null) return { ok: false, code: 'NOT_A_MEMBER', action, required_role: required, current_role: null };
      if (RANK[entry.role] >= RANK[required]) return { ok: true, action, role: entry.role };
      return { ok: false, code: 'FORBIDDEN_ACTION', action, required_role: required, current_role: entry.role };
    },
    /** A project snapshot carrying the event sequence it is consistent with. */
    snapshot({ projectId, extras = {} }) {
      const project = requireProject(projectId);
      return {
        project: {
          project_id: project.project_id,
          name: project.name,
          origin: project.origin,
          created_at: project.created_at,
          created_by: project.created_by,
          settings: { ...project.settings },
        },
        members: project.members.map((entry) => ({ ...entry })),
        ...extras,
        last_event_seq: seq,
      };
    },
    /** Incremental events for one project, seq strictly greater than sinceSeq. */
    events({ projectId, sinceSeq = 0, limit = 200 }) {
      requireProject(projectId);
      const slice = events.filter((event) => event.project_id === projectId && event.seq > sinceSeq).slice(0, limit);
      return { events: slice.map((event) => ({ ...event, payload: { ...event.payload } })), next_seq: slice.length > 0 ? slice[slice.length - 1].seq : sinceSeq };
    },
    /** Projects a member belongs to. */
    listProjects({ member }) {
      return { projects: [...projects.values()].filter((project) => findMember(project, member) !== null).map((project) => ({ project_id: project.project_id, name: project.name, origin: project.origin })) };
    },
    appendEvent({ projectId, type, actor, payload = {} }) {
      requireProject(projectId);
      return { ok: true, event: emit(projectId, type, actor, payload) };
    },
    size() { return { projects: projects.size, events: events.length, last_seq: seq }; },
  };
}
