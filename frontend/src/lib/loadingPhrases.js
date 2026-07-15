// Phrases rotatives pendant que l'agent réfléchit/génère — mélange de
// classiques repris du catalogue qwen-code (voir architecture.md) et de
// phrases maison, projets Julien + Pokémon.
export const LOADING_PHRASES = [
  // qwen-code (traduction FR du catalogue officiel)
  "Engagement de l'entraînement de l'improbabilité...",
  "Réchauffement des hamsters IA...",
  "Défragmentation des mémoires... RAM et personnelles...",
  "Conversion de café en code...",
  "Recâblage des synapses...",
  "Recherche d'un point-virgule égaré...",
  "Calibrage du condensateur de flux...",
  "Canalisation de la Force...",
  "Vitesse warp enclenchée...",
  "Extraction de plus de cristaux de Dilithium...",
  "Finir la course de Kessel en moins de 12 parsecs...",
  "Suivre le lapin blanc...",
  "Le gâteau n'est pas un mensonge, il charge juste encore...",
  "Essai de quitter Vim...",
  "Ce n'est pas un bug, c'est une fonctionnalité non documentée...",
  "Je viens de me souvenir où j'ai mis mes clés...",
  "Mise en marche de la roue du hamster...",
  "Application de la maintenance percussive...",
  "Pourquoi le développeur est-il fauché ? Parce qu'il a utilisé tout son cache...",
  "Résolution des dépendances... et des crises existentielles...",

  // Maison, projets
  "Réveil de Leeroy, café virtuel en cours...",
  "Négociation de VRAM avec llama-swap...",
  "Recherche de la recette AppCook sans légumineuses...",
  "Veille technique en cours sur Pulse...",
  "Compilation de l'hexagone du portfolio...",
  "DAEMON s'auto-limite pendant que je réfléchis, l'ironie...",
  "Chargement de la VHS néo-rétro de Video Future...",
  "Dépoussiérage du violet #6050DC...",
  "Vérification qu'aucun tenseur MoE ne traîne en RAM...",
  "Consultation du journal avant de répondre...",

  // Maison, Pokémon
  "EV training en cours, patience...",
  "Recherche de la synergie parfaite dans l'équipe...",
  "Attente de l'évolution tardive...",
  "Calcul des dégâts avant le prochain tour...",
  "Fouille du PC de stockage pour la bonne stratégie...",
  "Un Pokémon sauvage IA est apparu...",
  "Optimisation des IV comme un vrai min-maxeur...",
  "Sélection du meilleur moveset...",
]

export function randomPhrase(excluding) {
  if (LOADING_PHRASES.length <= 1) return LOADING_PHRASES[0]
  let phrase
  do {
    phrase = LOADING_PHRASES[Math.floor(Math.random() * LOADING_PHRASES.length)]
  } while (phrase === excluding)
  return phrase
}
