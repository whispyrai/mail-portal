import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  fetchConversationIntelligence,
  type ConversationIntelligenceResponse,
} from "../services/conversation-intelligence.ts";

export function conversationIntelligenceKey(
  mailboxId: string,
  emailId: string,
) {
  return ["conversation-intelligence", mailboxId, emailId] as const;
}

export type ConversationIntelligenceRefreshVariables = {
  mailboxId: string;
  emailId: string;
};

type IntelligenceRequest = (
  mailboxId: string,
  emailId: string,
  refresh: boolean,
) => Promise<ConversationIntelligenceResponse>;

export function isCurrentConversationIntelligenceRefresh(
  variables: ConversationIntelligenceRefreshVariables | undefined,
  mailboxId: string,
  emailId: string,
) {
  return (
    variables?.mailboxId === mailboxId && variables?.emailId === emailId
  );
}

export function buildConversationIntelligenceRefreshOptions(
  queryClient: QueryClient,
  mailboxId: string,
  emailId: string,
  request: IntelligenceRequest = fetchConversationIntelligence,
) {
  return {
    mutationKey: [
      ...conversationIntelligenceKey(mailboxId, emailId),
      "refresh",
    ] as const,
    mutationFn: (variables: ConversationIntelligenceRefreshVariables) =>
      request(variables.mailboxId, variables.emailId, true),
    onSuccess: (
      response: ConversationIntelligenceResponse,
      variables: ConversationIntelligenceRefreshVariables,
    ) => {
      queryClient.setQueryData(
        conversationIntelligenceKey(variables.mailboxId, variables.emailId),
        response,
      );
    },
  };
}

export function useConversationIntelligence(
  mailboxId: string,
  emailId: string,
  enabled: boolean,
) {
  const queryClient = useQueryClient();
  const key = conversationIntelligenceKey(mailboxId, emailId);
  const query = useQuery({
    queryKey: key,
    queryFn: () => fetchConversationIntelligence(mailboxId, emailId, false),
    enabled: enabled && Boolean(mailboxId && emailId),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const refresh = useMutation(
    buildConversationIntelligenceRefreshOptions(
      queryClient,
      mailboxId,
      emailId,
    ),
  );
  const refreshIsCurrent = isCurrentConversationIntelligenceRefresh(
    refresh.variables,
    mailboxId,
    emailId,
  );
  return {
    ...query,
    refresh: () => refresh.mutate({ mailboxId, emailId }),
    isRefreshing: refresh.isPending && refreshIsCurrent,
    refreshError: refreshIsCurrent ? refresh.error : null,
  };
}
