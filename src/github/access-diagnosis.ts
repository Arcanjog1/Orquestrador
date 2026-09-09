/**
 * Why the repository could not be read, when a stored login was not enough.
 *
 * ## What went wrong
 *
 * A person created the private repository `Arcanjog1/teste`, connected GitHub,
 * authorised the App on the official screen, selected the project - and the
 * application answered **404**, with every field of the capabilities panel
 * reading "não informado". Nothing on that screen could tell them what to do,
 * because the application had folded four different situations into one
 * status code:
 *
 *  1. nobody is signed in, and a private repository cannot be read anonymously;
 *  2. the credential expired and the refresh failed - and the read then went
 *     out **anonymously**, which for a private repository is a 404;
 *  3. the App is authorised on the account but **not installed on this
 *     repository** - GitHub answers 404 for that too, on purpose, so that a
 *     token cannot be used to enumerate private repositories;
 *  4. the repository really does not exist.
 *
 * Only the fourth is "not found". The other three are fixable, and each has a
 * different fix. Case 3 is the one that bites hardest, because everything
 * *looks* authorised: the account said yes, the token is stored, the login
 * shows - and the installation covers a different set of repositories.
 *
 * ## The rules this file keeps
 *
 * - **A stored token is not proof of access.** The verdict comes from what the
 *   repository request actually answered, plus what the installation actually
 *   covers - never from the presence of a row in a settings table.
 * - **Anonymous is never a silent fallback.** A private repository read
 *   without a credential is reported as a credential problem, not as absence.
 * - **The action is official.** Every fixable case names a page GitHub itself
 *   serves. No token is ever requested, anywhere, for any of them.
 * - **Uncertainty is said, not smoothed.** When the installations could not be
 *   listed, the diagnosis says which possibilities remain rather than picking
 *   the most likely one and sounding sure.
 */

/** How the repository request ended, in this application's own vocabulary. */
export type RequestOutcome = 'ok' | 'auth' | 'forbidden' | 'not-found' | 'rate-limit' | 'network' | 'api';

/** What the application holds, and whether it could actually be used. */
export type CredentialState =
  /** No login stored at all. */
  | 'absent'
  /** A login is stored and was usable for this request. */
  | 'usable'
  /** A login is stored and could not be renewed, so nothing was sent. */
  | 'expired';

export interface Installation {
  readonly id: number;
  readonly appSlug: string | null;
  readonly account: string | null;
  /** `all` or `selected`, as GitHub reports it. */
  readonly repositorySelection: string | null;
  /** The page where the person changes which repositories are included. */
  readonly htmlUrl: string | null;
}

export interface AccessFacts {
  /** `owner/name`, as asked for. */
  readonly repository: string;
  readonly owner: string;
  readonly credential: CredentialState;
  /** The login GitHub reported for the credential, when it was asked. */
  readonly identity: string | null;
  /** How `GET /repos/{owner}/{repo}` ended. */
  readonly outcome: RequestOutcome;
  /**
   * The installations this credential can see, or null when they could not be
   * listed - which is itself a fact, and changes the answer.
   */
  readonly installations: readonly Installation[] | null;
  /**
   * Whether an installation covering this owner lists this repository. Null
   * when it could not be checked.
   */
  readonly repositoryInInstallation: boolean | null;
}

export type AccessProblem =
  | 'ok'
  | 'not-connected'
  | 'credential-expired'
  | 'app-not-installed'
  | 'repository-not-in-installation'
  | 'insufficient-permission'
  | 'repository-missing'
  | 'rate-limited'
  | 'network'
  | 'unknown';

export interface AccessAction {
  readonly label: string;
  readonly url: string;
}

export interface AccessDiagnosis {
  readonly problem: AccessProblem;
  /** One paragraph a person can act on. Never "erro do GitHub". */
  readonly summary: string;
  /** The official page that fixes it, when there is one. */
  readonly action: AccessAction | null;
}

/** Where a person changes which repositories an installation covers. */
const INSTALLATIONS_PAGE = 'https://github.com/settings/installations';

/**
 * The verdict, from measured facts alone.
 *
 * The order matters: a credential problem outranks an installation problem,
 * because sending nothing and being refused are different failures and the
 * first explains the second.
 */
export function diagnoseAccess(facts: AccessFacts): AccessDiagnosis {
  if (facts.outcome === 'ok') {
    return { problem: 'ok', summary: `${facts.repository} está acessível.`, action: null };
  }
  if (facts.outcome === 'network') {
    return {
      problem: 'network',
      summary:
        'Não consegui falar com o GitHub. Isto não diz nada sobre o repositório: pode ser a rede, ' +
        'um proxy ou o GitHub fora do ar. Tente de novo.',
      action: null,
    };
  }
  if (facts.outcome === 'rate-limit') {
    return {
      problem: 'rate-limited',
      summary:
        'O GitHub limitou a quantidade de requisições desta conexão por enquanto. Isto não diz ' +
        'nada sobre o repositório; espere alguns minutos e tente de novo.',
      action: null,
    };
  }

  // Nothing was sent. For a private repository that is indistinguishable from
  // absence at GitHub's end - so it must not be reported as absence here.
  if (facts.credential === 'absent') {
    return {
      problem: 'not-connected',
      summary:
        `Nenhuma conta do GitHub está conectada, então a leitura de ${facts.repository} foi anônima. ` +
        'Um repositório privado responde "não encontrado" a uma requisição anônima — de propósito, ' +
        'para não revelar quais repositórios privados existem. Conecte o GitHub em Contas e ' +
        'integrações e eu verifico de novo.',
      action: null,
    };
  }
  if (facts.credential === 'expired') {
    return {
      problem: 'credential-expired',
      summary:
        'O login do GitHub guardado neste computador expirou e não pôde ser renovado, então esta ' +
        `leitura saiu sem credencial — e ${facts.repository}, se for privado, responde "não ` +
        'encontrado" a isso. Conecte o GitHub novamente em Contas e integrações.',
      action: null,
    };
  }

  if (facts.outcome === 'auth') {
    return {
      problem: 'credential-expired',
      summary:
        'O GitHub não aceitou o login guardado neste computador. Conecte a conta novamente em ' +
        'Contas e integrações.',
      action: null,
    };
  }

  // From here the credential was sent and GitHub answered 403 or 404. The
  // installation is what decides which.
  const owner = facts.owner.toLowerCase();
  const covering = (facts.installations ?? []).filter(
    (installation) => (installation.account ?? '').toLowerCase() === owner,
  );
  const who = facts.identity ? ` A conta autenticada é ${facts.identity}.` : '';

  if (facts.installations !== null && covering.length === 0) {
    return {
      problem: 'app-not-installed',
      summary:
        `O aplicativo está autorizado na sua conta, mas não está **instalado** em ${facts.owner}. ` +
        'Autorizar a conta e instalar o App são duas coisas diferentes: a primeira deixa o ' +
        'aplicativo saber quem você é, e só a segunda dá acesso a repositórios.' +
        `${who} Instale o App em ${facts.owner} e inclua ${facts.repository}.`,
      action: { label: 'Abrir as instalações do GitHub', url: INSTALLATIONS_PAGE },
    };
  }

  if (facts.repositoryInInstallation === false) {
    const selected = covering.find((i) => i.repositorySelection === 'selected') ?? covering[0];
    return {
      problem: 'repository-not-in-installation',
      summary:
        `O App está instalado em ${facts.owner}, mas ${facts.repository} não está entre os ` +
        'repositórios incluídos na instalação. É por isso que o GitHub responde "não encontrado" ' +
        'em vez de "sem permissão": ele não revela a existência de um repositório privado a quem ' +
        `não tem acesso.${who} Abra a instalação, escolha "Only select repositories" e adicione ` +
        `${facts.repository} — ou selecione "All repositories".`,
      action: {
        label: 'Escolher os repositórios da instalação',
        url: selected?.htmlUrl ?? INSTALLATIONS_PAGE,
      },
    };
  }

  if (facts.outcome === 'forbidden') {
    const installation = covering[0];
    return {
      problem: 'insufficient-permission',
      summary:
        `O App alcança ${facts.repository}, mas o GitHub recusou esta operação por permissão. ` +
        'Para ler e alterar código o App precisa de **Contents: Read and write**, e para abrir um ' +
        'pull request precisa de **Pull requests: Read and write**. Ajuste as permissões do App e ' +
        'aceite a atualização na instalação.' +
        who,
      action: {
        label: 'Abrir a instalação do App',
        url: installation?.htmlUrl ?? INSTALLATIONS_PAGE,
      },
    };
  }

  // Authenticated, the installation covers it, and GitHub still says no.
  if (facts.repositoryInInstallation === true) {
    return {
      problem: 'repository-missing',
      summary:
        `A instalação inclui ${facts.repository} e mesmo assim o GitHub respondeu "não encontrado". ` +
        'Confira se o nome está escrito exatamente como no GitHub, incluindo maiúsculas e ' +
        'minúsculas do dono, e se o repositório não foi renomeado ou removido.',
      action: null,
    };
  }

  // The installations could not be listed. Say which possibilities remain
  // instead of choosing one and sounding certain.
  return {
    problem: 'unknown',
    summary:
      `O GitHub respondeu "não encontrado" para ${facts.repository} com a conta conectada, e eu ` +
      'não consegui listar as instalações do App para saber por quê.' +
      `${who} Restam três possibilidades: o App não está instalado em ${facts.owner}; está ` +
      `instalado mas sem ${facts.repository} entre os repositórios incluídos; ou o nome está ` +
      'diferente do que existe no GitHub. A primeira e a segunda se resolvem na mesma tela.',
    action: { label: 'Abrir as instalações do GitHub', url: INSTALLATIONS_PAGE },
  };
}

/** True when the person can fix this themselves on a GitHub page. */
export function isFixable(problem: AccessProblem): boolean {
  return (
    problem === 'app-not-installed' ||
    problem === 'repository-not-in-installation' ||
    problem === 'insufficient-permission'
  );
}
