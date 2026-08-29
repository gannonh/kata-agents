import type { TFunction } from 'i18next'
import type { HandoffRailView } from '@kata-sh/shared/protocol'

export function handoffStateLabel(t: TFunction, rail: HandoffRailView): string {
  const state = rail.task?.runtimeState ?? rail.delivery.mailState
  switch (state) {
    case 'pending': return t('handoffs.statePending')
    case 'claimed': return t('handoffs.stateClaimed')
    case 'acknowledged': return t('handoffs.stateAcknowledged')
    case 'delivery-failed': return t('handoffs.stateDeliveryFailed')
    case 'queued': return t('handoffs.stateQueued')
    case 'processing': return t('handoffs.stateProcessing')
    case 'awaiting-input': return t('handoffs.stateAwaitingInput')
    case 'completed': return t('handoffs.stateCompleted')
    case 'failed': return t('handoffs.stateFailed')
    case 'cancelled': return t('handoffs.stateCancelled')
  }
}
