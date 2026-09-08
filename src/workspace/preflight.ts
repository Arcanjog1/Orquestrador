/**
 * Is this the folder the objective is about?
 *
 * ## The incident
 *
 * A task meant for `Arcanjog1/Orquestrador` was started in
 * `C:\Users\twitc\Desktop\Orquestrador-claude-new-session-3am7mo`. The baseline
 * said, correctly, that the folder was not a git repository - and the run went
 * ahead anyway. The first delegation wrote a baseline document, the second
 * died in 5.3s, and the router escalated on "no progress". Nothing there could
 * have worked: the code the objective was about was not in that folder.
 *
 * The name looked right. That is exactly why a name is not evidence, and why
 * nothing here compares one.
 *
 * ## What this decides, and what it deliberately does not
 *
 * It answers one question with facts the caller collected: **can a delegation
 * that changes code run here?** It blocks only when the project itself
 * declares a repository and the folder is provably not that repository -
 * missing, not a checkout, or a checkout of something else. A declared
 * identity compared against a real remote is evidence; a folder name is not.
 *
 * A project that is only a folder is never blocked on git grounds. Creating
 * `hello.txt` in a folder with no repository is a legitimate task and stays
 * one - blocking it would trade one broken behaviour for another.
 *
 * A dirty tree never blocks. It is reported, and it forbids the *preparation*
 * steps that could overwrite work: no checkout, no pull, no reset.
 */

import { repositoryKey } from '../github/repository-identity.js';

/** What the caller measured about the folder. Nothing here is guessed. */
export interface PreflightFacts {
  /** The folder a run would execute in. Empty when the project has none yet. */
  readonly workspacePath: string;
  readonly folderExists: boolean;
  readonly isGitRepository: boolean;
  /** Set when git itself could not answer - which is not the same as "no". */
  readonly gitProblem: string | null;
  /** `origin`, as `.git/config` holds it. Null when the checkout has none. */
  readonly remoteUrl: string | null;
  readonly branch: string | null;
  readonly dirty: boolean;
  /** The repository the *project* declares. Null when it declares none. */
  readonly declaredRepositoryUrl: string | null;
  /** The branch GitHub reported. Never assumed to be `main`. */
  readonly declaredDefaultBranch: string | null;
}

export type PreflightKind =
  | 'ready'
  | 'ready-without-git'
  | 'no-workspace'
  | 'folder-missing'
  | 'git-unavailable'
  | 'not-a-repository'
  | 'no-remote'
  | 'remote-mismatch';

/** What the person can do about it, in the order the interface should offer. */
export type PreflightAction = 'clone-repository' | 'associate-folder';

export interface PreflightResult {
  readonly kind: PreflightKind;
  /** True when a delegation that changes code must not be sent. */
  readonly blocksCodeWork: boolean;
  /** One line, for a heading. */
  readonly title: string;
  /** What was measured and what it means, for the person and the supervisor. */
  readonly detail: string;
  readonly actions: readonly PreflightAction[];
  /** Reported, never blocking. Preparation must not overwrite these. */
  readonly dirty: boolean;
  readonly branch: string | null;
  readonly remoteUrl: string | null;
  readonly declaredRepositoryUrl: string | null;
}

export function assessPreflight(facts: PreflightFacts): PreflightResult {
  const declared = facts.declaredRepositoryUrl?.trim() ?? '';
  const wantsRepository = repositoryKey(declared).length > 0;
  const base = {
    dirty: facts.dirty,
    branch: facts.branch,
    remoteUrl: facts.remoteUrl,
    declaredRepositoryUrl: declared || null,
  } as const;

  // No folder at all. Nothing can be written, whatever the objective is.
  if (facts.workspacePath.trim().length === 0) {
    return {
      ...base,
      kind: 'no-workspace',
      blocksCodeWork: true,
      title: 'Este projeto ainda não tem uma pasta de código.',
      detail: wantsRepository
        ? `O projeto está ligado a ${declared}, mas nenhum checkout local foi preparado. ` +
          'Clone o repositório ou associe uma pasta que já contenha esse checkout.'
        : 'O projeto existe apenas como conversa. Associe uma pasta para poder alterar arquivos.',
      actions: wantsRepository ? ['clone-repository', 'associate-folder'] : ['associate-folder'],
    };
  }

  if (!facts.folderExists) {
    return {
      ...base,
      kind: 'folder-missing',
      blocksCodeWork: true,
      title: 'A pasta do projeto não existe mais.',
      detail:
        `O projeto aponta para "${facts.workspacePath}", que não está mais lá. ` +
        'Nada foi criado nem apagado. Associe a pasta atual' +
        (wantsRepository ? ' ou clone o repositório novamente.' : '.'),
      actions: wantsRepository ? ['clone-repository', 'associate-folder'] : ['associate-folder'],
    };
  }

  // A project that declares no repository is not measured against one. This is
  // the `hello.txt` case, and it must keep working.
  if (!wantsRepository) {
    return {
      ...base,
      kind: facts.isGitRepository ? 'ready' : 'ready-without-git',
      blocksCodeWork: false,
      title: facts.isGitRepository
        ? 'Pasta pronta, com repositório Git.'
        : 'Pasta pronta, sem repositório Git.',
      detail: facts.isGitRepository
        ? `${facts.workspacePath}${facts.branch ? ` · branch ${facts.branch}` : ''}`
        : `${facts.workspacePath} · não é um repositório Git. Tarefas de arquivo funcionam; ` +
          'não há diff, histórico nem branch para usar como evidência.',
      actions: [],
    };
  }

  // From here the project declares a repository, so the folder has to be that
  // repository - and the only way to know is to ask git and compare keys.
  if (facts.gitProblem) {
    return {
      ...base,
      kind: 'git-unavailable',
      blocksCodeWork: true,
      title: 'Não foi possível verificar a identidade da pasta.',
      detail:
        `O Git não respondeu nesta pasta (${facts.gitProblem}). Sem isso não dá para ` +
        `afirmar que "${facts.workspacePath}" é ${declared}, e um nome parecido não é prova.`,
      actions: [],
    };
  }

  if (!facts.isGitRepository) {
    return {
      ...base,
      kind: 'not-a-repository',
      blocksCodeWork: true,
      title: 'A pasta não é um checkout deste repositório.',
      detail:
        `"${facts.workspacePath}" não é um repositório Git, e este projeto está ligado a ` +
        `${declared}. Um nome parecido não torna a pasta o repositório certo. ` +
        'Clone o repositório ou associe a pasta que contém o checkout.',
      actions: ['clone-repository', 'associate-folder'],
    };
  }

  if (!facts.remoteUrl) {
    return {
      ...base,
      kind: 'no-remote',
      blocksCodeWork: true,
      title: 'O checkout não tem remoto.',
      detail:
        `"${facts.workspacePath}" é um repositório Git, mas não tem remoto configurado, ` +
        `então não há como confirmar que é ${declared}.`,
      actions: ['associate-folder', 'clone-repository'],
    };
  }

  if (repositoryKey(facts.remoteUrl) !== repositoryKey(declared)) {
    return {
      ...base,
      kind: 'remote-mismatch',
      blocksCodeWork: true,
      title: 'Esta pasta é de outro repositório.',
      detail:
        `O projeto é ${declared}, mas o remoto de "${facts.workspacePath}" é ` +
        `${facts.remoteUrl}. São repositórios diferentes; nada foi alterado.`,
      actions: ['clone-repository', 'associate-folder'],
    };
  }

  return {
    ...base,
    kind: 'ready',
    blocksCodeWork: false,
    title: 'Checkout confirmado.',
    detail:
      `${facts.workspacePath} · ${declared}` +
      `${facts.branch ? ` · branch ${facts.branch}` : ''}` +
      `${facts.declaredDefaultBranch ? ` · padrão ${facts.declaredDefaultBranch}` : ''}` +
      `${facts.dirty ? ' · árvore com alterações locais' : ''}`,
    actions: [],
  };
}

/**
 * The block for the supervisor's prompt.
 *
 * The supervisor cannot open the folder, so what it knows about the workspace
 * is what this says. Before it existed, a run in the wrong folder looked
 * exactly like a run in the right one, and the only way to find out was to
 * delegate and watch nothing happen.
 */
export function renderPreflight(result: PreflightResult): string {
  const lines = ['WORKSPACE CHECK (measured by the application, not reported by an agent):'];
  lines.push(`  ${result.title}`);
  lines.push(`  ${result.detail}`);
  if (result.dirty) {
    lines.push('  The working tree has local changes. Nothing here will overwrite them.');
  }
  if (result.blocksCodeWork) {
    lines.push(
      '  A delegation that changes code cannot run here. Do not delegate one, and do not',
      '  ask for a stronger model - this is not something a model fixes. Answer "blocked"',
      '  with this as the reason, unless the objective genuinely needs no code change.',
    );
  }
  return lines.join('\n');
}
