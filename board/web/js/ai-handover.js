// Exact displayed run binding for the two-step managed AI move. The hub
// independently checks the pin and its runner's checkpoint confirmation.
export function handoverPin(view) {
  return { expected_fence: view?.fence, prior_run_id: view?.run?.id };
}
export function sameHandover(view, pin) {
  return Number.isSafeInteger(pin?.expected_fence) && typeof pin?.prior_run_id === 'string'
    && view?.fence === pin.expected_fence && view?.run?.id === pin.prior_run_id;
}
